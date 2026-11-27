import React from "react";

/** The people an "@" suggestion can pick from. While the list is still loading, `get` answers with a promise, so an open popup fills once it arrives. */
export function mentionPeopleSource<T>() {
  let current: T[] | null = null;
  let resolve!: (people: T[]) => void;
  const arrived = new Promise<T[]>((done) => { resolve = done; });
  return {
    set(people: T[] | null) {
      current = people;
      if (people) resolve(people);
    },
    get: (): T[] | Promise<T[]> => current ?? arrived,
  };
}

export type MentionPeople<T> = Pick<ReturnType<typeof mentionPeopleSource<T>>, "get">;

/** The source for one editor, kept in step with the component's list. Pass null until the list has loaded. */
export function useMentionPeople<T>(people: T[] | null): MentionPeople<T> {
  const [source] = React.useState(() => mentionPeopleSource<T>());
  source.set(people);
  return source;
}
