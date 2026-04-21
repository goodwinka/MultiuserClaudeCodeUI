import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../../utils/api';
import { useWebSocket } from '../../../contexts/WebSocketContext';
import type { Project } from '../../../types/app';
import type { FileTreeNode } from '../types/types';

type UseFileTreeDataResult = {
  files: FileTreeNode[];
  loading: boolean;
  refreshFiles: () => void;
};

// Multi-user gateway patch (fix-chat-file-bugs):
// Upstream ClaudeCodeUI only runs its chokidar file watcher against provider
// project folders (~/.claude/projects, ~/.cursor/chats, etc.), so files the
// agent creates inside the user's workspace at /data/users/*/projects never
// trigger a `projects_updated` event for the file tree.  On top of that,
// inotify events across Docker bind mounts are unreliable even for paths
// that are being watched.  Without a refresh hook the user had to click the
// Refresh button every time the agent wrote a new file — a poor experience.
//
// This patch adds two listeners:
//   1. React to `projects_updated` / `websocket-reconnected` messages by
//      bumping refreshKey, so any gateway-side file-system signal we do
//      receive (e.g. from a jsonl session write that happens to be on the
//      same mount) translates into an immediate refetch.
//   2. A 10-second polling fallback that only runs when the tab is visible
//      and a project is selected.  This is the safety net for the cases
//      where no watcher signal arrives at all.

const POLL_INTERVAL_MS = 10_000;

export function useFileTreeData(selectedProject: Project | null): UseFileTreeDataResult {
  const [files, setFiles] = useState<FileTreeNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Read WebSocket defensively: if this hook is ever used outside the
  // provider (tests, storybook), keep the plain fetch behaviour instead of
  // throwing.
  let latestMessage: any = null;
  try {
    ({ latestMessage } = useWebSocket());
  } catch {
    latestMessage = null;
  }

  const refreshFiles = useCallback(() => {
    setRefreshKey((prev) => prev + 1);
  }, []);

  // WebSocket-driven refresh: react to the same signals the projects sidebar
  // listens to.  `projects_updated` covers agent-driven session file changes;
  // `websocket-reconnected` covers the per-user process restart after an
  // idle-timeout kill by the gateway.
  useEffect(() => {
    if (!latestMessage || !selectedProject?.name) return;
    const type = (latestMessage as { type?: string }).type;
    if (type === 'projects_updated' || type === 'websocket-reconnected') {
      setRefreshKey((prev) => prev + 1);
    }
  }, [latestMessage, selectedProject?.name]);

  // Polling fallback for Docker bind-mount inotify unreliability.  Only runs
  // while the document is visible and there's a project actually loaded.
  useEffect(() => {
    if (!selectedProject?.name) return;
    const intervalId = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      setRefreshKey((prev) => prev + 1);
    }, POLL_INTERVAL_MS);

    const handleFocus = () => setRefreshKey((prev) => prev + 1);
    const handleVisibility = () => {
      if (typeof document !== 'undefined' && !document.hidden) {
        setRefreshKey((prev) => prev + 1);
      }
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', handleFocus);
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibility);
    }

    return () => {
      clearInterval(intervalId);
      if (typeof window !== 'undefined') {
        window.removeEventListener('focus', handleFocus);
      }
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibility);
      }
    };
  }, [selectedProject?.name]);

  useEffect(() => {
    const projectName = selectedProject?.name;

    if (!projectName) {
      setFiles([]);
      setLoading(false);
      return;
    }

    // Abort previous request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();

    // Track mount state so aborted or late responses do not enqueue stale state updates.
    let isActive = true;

    // On initial mount / project switch we show the loading state; on silent
    // refreshes driven by the poller or websocket we do not — otherwise the
    // tree would flash every 10 seconds.
    const isInitialFetch = refreshKey === 0;

    const fetchFiles = async () => {
      if (isActive && isInitialFetch) {
        setLoading(true);
      }
      try {
        const response = await api.getFiles(projectName, { signal: abortControllerRef.current!.signal });

        if (!response.ok) {
          const errorText = await response.text();
          console.error('File fetch failed:', response.status, errorText);
          if (isActive) {
            // Don't wipe the current view on a failed background refresh —
            // only clear on the initial load.
            if (isInitialFetch) setFiles([]);
          }
          return;
        }

        const data = (await response.json()) as FileTreeNode[];
        if (isActive) {
          setFiles(data);
        }
      } catch (error) {
        if ((error as { name?: string }).name === 'AbortError') {
          return;
        }

        console.error('Error fetching files:', error);
        if (isActive && isInitialFetch) {
          setFiles([]);
        }
      } finally {
        if (isActive && isInitialFetch) {
          setLoading(false);
        }
      }
    };

    void fetchFiles();

    return () => {
      isActive = false;
      abortControllerRef.current?.abort();
    };
  }, [selectedProject?.name, refreshKey]);

  return {
    files,
    loading,
    refreshFiles,
  };
}
