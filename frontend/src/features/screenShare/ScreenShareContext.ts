import { createContext } from "react";
import type { PublicCallUser } from "../calls/types";
import type { ScreenShareInvite, ScreenShareRole, ScreenShareSession, ScreenShareSource, ScreenShareUiState } from "./types";

export type ScreenShareContextValue = {
  uiState: ScreenShareUiState;
  role: ScreenShareRole | null;
  session: ScreenShareSession | null;
  requestPeer: PublicCallUser | null;
  pendingInvite: ScreenShareInvite | null;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  error: string;
  muted: boolean;
  paused: boolean;
  startedAt: number | null;
  requestShare: (peer: PublicCallUser) => void;
  cancelRequest: () => void;
  startShare: (source: ScreenShareSource) => Promise<void>;
  joinInvite: (invite?: ScreenShareInvite | null) => Promise<void>;
  joinInviteLink: (sessionId: string, inviteToken?: string | null) => Promise<void>;
  declineInvite: () => Promise<void>;
  stopShare: () => Promise<void>;
  toggleMute: () => void;
  togglePause: () => void;
  copyInviteLink: () => Promise<void>;
  clearError: () => void;
};

export const ScreenShareContext = createContext<ScreenShareContextValue | null>(null);
