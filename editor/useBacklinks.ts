import { useCallback, useMemo } from 'react';
import {
  createEditor,
  Descendant,
  Editor,
  Element,
  Node,
  Path,
  Transforms,
} from 'slate';
import produce from 'immer';
import { mutate } from 'swr';
import { ElementType } from 'types/slate';
import { Note } from 'types/supabase';
import useNotes, { NOTES_KEY } from 'lib/api/useNotes';
import supabase from 'lib/supabase';

export type Backlink = {
  id: string;
  title: string;
  matches: Array<{
    context: string;
    path: Path;
  }>;
};

export default function useBacklinks(noteId: string) {
  const { data: notes = [] } = useNotes();
  const linkedBacklinks = useMemo(
    () => getLinkedBacklinks(notes, noteId),
    [notes, noteId]
  );
  const unlinkedBacklinks = useMemo(() => {
    const noteTitle = notes.find((note) => note.id === noteId)?.title;
    return noteTitle ? getUnlinkedBacklinks(notes, noteTitle) : [];
  }, [notes, noteId]);

  /**
   * Updates the link properties of the backlinks on each backlinked note when the
   * current note title has changed.
   */
  const updateBacklinks = useCallback(
    async (newTitle: string) => {
      const updateData = [];
      for (const backlink of linkedBacklinks) {
        // TODO: this can still result in a race condition if the content is updated elsewhere
        // after we get the note and before we update the backlinks.
        const { data: note } = await supabase
          .from<Note>('notes')
          .select('id, content')
          .eq('id', backlink.id)
          .single();

        if (!note) {
          continue;
        }

        const matches = getLinkedMatches(note.content, noteId); // Compute matches for the db note
        let newBacklinkContent = note.content;
        for (const match of matches) {
          newBacklinkContent = produce(newBacklinkContent, (draftState) => {
            // Path should not be empty
            const path = match.path;
            if (path.length <= 0) {
              return;
            }

            // Get the node from the path
            let linkNode = draftState[path[0]];
            for (const pathNumber of path.slice(1)) {
              linkNode = (linkNode as Element).children[pathNumber];
            }

            // Assert that linkNode is a note link
            if (
              !Element.isElement(linkNode) ||
              linkNode.type !== ElementType.NoteLink
            ) {
              return;
            }

            // Update noteTitle property on the node
            linkNode.noteTitle = newTitle;

            // If isTextTitle is true, then the link text should always be equal to the note title
            if (linkNode.isTextTitle) {
              for (const linkNodeChild of linkNode.children) {
                linkNodeChild.text = newTitle;
              }
            }
          });
        }
        updateData.push({
          id: backlink.id,
          content: newBacklinkContent,
        });
      }

      // It would be better if we could consolidate the update requests into one request
      // See https://github.com/supabase/supabase-js/issues/156
      const promises = [];
      for (const data of updateData) {
        promises.push(
          supabase
            .from<Note>('notes')
            .update({ content: data.content })
            .eq('id', data.id)
        );
      }
      await Promise.all(promises);

      mutate(NOTES_KEY); // Make sure backlinks are updated
    },
    [linkedBacklinks, noteId]
  );

  /**
   * Deletes the backlinks on each backlinked note and replaces them with the link text.
   */
  const deleteBacklinks = useCallback(async () => {
    const updateData = [];
    for (const backlink of linkedBacklinks) {
      // TODO: this can still result in a race condition if the content is updated elsewhere
      // after we get the note and before we update the backlinks.
      const { data: note } = await supabase
        .from<Note>('notes')
        .select('id, content')
        .eq('id', backlink.id)
        .single();

      if (!note) {
        continue;
      }

      const editor = createEditor();
      editor.children = note.content;

      Transforms.unwrapNodes(editor, {
        at: [],
        match: (n) =>
          !Editor.isEditor(n) &&
          Element.isElement(n) &&
          n.type === ElementType.NoteLink &&
          n.noteId === noteId,
      });

      updateData.push({
        id: backlink.id,
        content: editor.children,
      });
    }

    // It would be better if we could consolidate the update requests into one request
    // See https://github.com/supabase/supabase-js/issues/156
    const promises = [];
    for (const data of updateData) {
      promises.push(
        supabase
          .from<Note>('notes')
          .update({ content: data.content })
          .eq('id', data.id)
      );
    }
    await Promise.all(promises);

    mutate(NOTES_KEY); // Make sure backlinks are updated
  }, [linkedBacklinks, noteId]);

  return {
    linkedBacklinks,
    unlinkedBacklinks,
    updateBacklinks,
    deleteBacklinks,
  };
}

/**
 * Searches the notes array for note links to the given noteId
 * and returns an array of the matches.
 */
const getLinkedBacklinks = (notes: Note[], noteId: string): Backlink[] => {
  const result: Backlink[] = [];
  for (const note of notes) {
    const matches = getLinkedMatches(note.content, noteId);
    if (matches.length > 0) {
      result.push({
        id: note.id,
        title: note.title,
        matches,
      });
    }
  }
  return result;
};

/**
 * Searches the notes array for text matches to the given noteTitle
 * and returns an array of the matches.
 */
const getUnlinkedBacklinks = (notes: Note[], noteTitle: string): Backlink[] => {
  const result: Backlink[] = [];
  for (const note of notes) {
    if (note.title === noteTitle) {
      // We skip getting unlinked backlinks if the note titles are the same
      continue;
    }
    const matches = getUnlinkedMatches(note.content, noteTitle);
    if (matches.length > 0) {
      result.push({
        id: note.id,
        title: note.title,
        matches,
      });
    }
  }
  return result;
};

const getLinkedMatches = (nodes: Descendant[], noteId: string) => {
  const editor = createEditor();
  editor.children = nodes;

  // Find note link elements that match noteId
  const matchingElements = Editor.nodes(editor, {
    at: [],
    match: (n) =>
      Element.isElement(n) &&
      n.type === ElementType.NoteLink &&
      n.noteId === noteId &&
      !!Node.string(n), // We ignore note links with empty link text
  });

  const result: Backlink['matches'] = [];
  for (const [, path] of matchingElements) {
    const parent = Node.parent(editor, path);
    result.push({ context: Node.string(parent), path });
  }
  return result;
};

const getUnlinkedMatches = (nodes: Descendant[], noteTitle: string) => {
  const editor = createEditor();
  editor.children = nodes;

  // Remove note links
  Transforms.removeNodes(editor, {
    at: [],
    match: (n) => Element.isElement(n) && n.type === ElementType.NoteLink,
  });

  // Find elements that have noteTitle in them
  const matchingElements = Editor.nodes(editor, {
    at: [],
    mode: 'lowest',
    match: (n) =>
      Element.isElement(n) &&
      Node.string(n).toLowerCase().includes(noteTitle.toLowerCase()),
  });

  const result: Backlink['matches'] = [];
  for (const [node, path] of matchingElements) {
    result.push({ context: Node.string(node), path });
  }
  return result;
};