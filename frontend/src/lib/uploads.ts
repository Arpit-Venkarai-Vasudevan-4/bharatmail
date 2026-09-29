import {t} from '../i18n';
import { api, ApiError, apiResponse } from './api';

export type UploadStatus = { id: string; status: string; offset: number; expectedBytes: number; expiresAt?: string };
type UploadOptions = { signal?: AbortSignal; onProgress?: (percent: number) => void; uploadId?: string; onUploadId?: (id: string) => void };
export function safeFilename(name: string) { return name.replace(/[^\x20-\x7e]|[/\\]/g, '_').slice(0, 120) || 'attachment'; }
export async function uploadStatus(id: string, signal?: AbortSignal): Promise<UploadStatus> {
  return (await api<{ upload: UploadStatus }>(`/uploads/${encodeURIComponent(id)}/status`, { signal })).upload;
}

export async function uploadFile(file: File, options: UploadOptions = {}) {
  if (!file.size || file.size > 10 * 1024 * 1024) throw new Error(t("m_2c965806e0a9"));
  options.signal?.throwIfAborted();
  let state: UploadStatus;
  if (options.uploadId) state = await uploadStatus(options.uploadId, options.signal);
  else {
    state = (await api<{ upload: UploadStatus }>('/uploads', { method: 'POST', signal: options.signal, headers: {
      'X-Expected-Bytes': String(file.size), 'X-Filename': safeFilename(file.name), 'X-Upload-Mode': 'resumable',
      'Content-Type': file.type || 'application/octet-stream',
    } })).upload;
    if (!state?.id) throw new Error(t("m_9837940e1dac"));
    options.onUploadId?.(state.id);
  }
  const id = state.id;
  let recoveryAttempts = 0;
  while (true) {
    options.signal?.throwIfAborted();
    const offset = Number(state.offset);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > file.size || Number(state.expectedBytes) !== file.size) throw new Error(t("m_bfbd93e85246"));
    options.onProgress?.(Math.round(offset / file.size * 100));
    if (state.status === 'ready' && offset === file.size) return { id, status: 'ready', offset };
    if (state.status !== 'staged' || offset === file.size) throw new Error(t("m_5a9dc956f8d9",{value0:state.status}));
    const end = Math.min(file.size, offset + 1024 * 1024);
    try {
      state = (await api<{ upload: UploadStatus }>(`/uploads/${encodeURIComponent(id)}`, {
        method: 'PATCH', body: file.slice(offset, end), signal: options.signal,
        headers: { 'X-Upload-Offset': String(offset), 'Content-Type': 'application/octet-stream' },
      })).upload;
      if (Number(state.offset) <= offset) throw new Error(t("m_2947e0bf7629"));
      recoveryAttempts = 0;
    } catch (error) {
      if (options.signal?.aborted) throw error;
      if (!(error instanceof ApiError) || ![0, 409, 408, 502, 503, 504].includes(error.status) || ++recoveryAttempts > 2) throw error;
      state = await uploadStatus(id, options.signal);
    }
  }
}

export async function downloadAttachment(id: string, filename: string) {
  const response = await apiResponse(`/uploads/${encodeURIComponent(id)}`);
  const blob = await response.blob();
  const url = URL.createObjectURL(blob); const link = document.createElement('a');
  link.href = url; link.download = safeFilename(filename); link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
