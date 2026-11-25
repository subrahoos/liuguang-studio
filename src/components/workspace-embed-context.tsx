"use client";

import { createContext, useContext, type ReactNode } from "react";

type WorkspaceEmbedContextValue = {
  embedded: boolean;
  onProjectCreated?: (targetPath: string) => void;
};

const WorkspaceEmbedContext = createContext<WorkspaceEmbedContextValue>({ embedded: false });

export function WorkspaceEmbedProvider({
  children,
  onProjectCreated,
}: {
  children: ReactNode;
  onProjectCreated?: (targetPath: string) => void;
}) {
  return (
    <WorkspaceEmbedContext.Provider value={{ embedded: true, onProjectCreated }}>
      {children}
    </WorkspaceEmbedContext.Provider>
  );
}

export function useWorkspaceEmbed() {
  return useContext(WorkspaceEmbedContext);
}
