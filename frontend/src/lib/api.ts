export interface ApiResponse<T = any> {
  success: boolean;
  data: T;
  error?: {
    code: string;
    message: string;
    details?: any;
    issues?: { path: string; message: string }[];
  };
}

export class ApiError extends Error {
  public code: string;
  public details?: any;
  public status: number;

  constructor(message: string, code: string = 'API_ERROR', status: number = 400, details?: any) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const BASE_URL = '/api/v1';

async function request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const url = `${BASE_URL}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;

  const token = localStorage.getItem('radar_token');

  // Only forward a real bearer token. The HttpOnly session cookie is the source
  // of truth; stale localStorage ids (e.g. dev-mock values that are not valid
  // ObjectIds) must never be sent as x-user-id / x-organization-id identity
  // headers, which caused spurious 400s and phantom sessions.
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(options.headers as Record<string, string>),
  };

  const response = await fetch(url, {
    ...options,
    credentials: 'include',
    headers,
  });

  const contentType = response.headers.get('content-type');
  let data: any = null;
  if (contentType && contentType.includes('application/json')) {
    data = await response.json();
  }

  if (!response.ok) {
    const errorInfo = data?.error;
    throw new ApiError(
      errorInfo?.message || `HTTP ${response.status}: ${response.statusText}`,
      errorInfo?.code || 'SERVER_ERROR',
      response.status,
      errorInfo?.details || errorInfo?.issues
    );
  }

  return data?.data !== undefined ? data.data : data;
}

export interface ChunkedUploadProgress {
  uploadedBytes: number;
  totalBytes: number;
  percent: number;
  currentChunk: number;
  totalChunks: number;
  uploadSpeedBytesPerSecond: number;
  estimatedRemainingSeconds: number;
}

export interface ChunkedUploadResult {
  uploadId: string;
  storedFilePath: string;
  fileName: string;
  fileSize: number;
  fileType: 'csv' | 'xlsx';
  headers: string[];
  sampleRows: Record<string, string>[];
  totalRows: number;
  totalRowsIsExact: boolean;
  delimiter: string;
}

export const api = {
  get: <T>(endpoint: string) => request<T>(endpoint, { method: 'GET' }),
  post: <T>(endpoint: string, body?: any) =>
    request<T>(endpoint, { method: 'POST', body: body ? JSON.stringify(body) : undefined }),
  put: <T>(endpoint: string, body?: any) =>
    request<T>(endpoint, { method: 'PUT', body: body ? JSON.stringify(body) : undefined }),
  patch: <T>(endpoint: string, body?: any) =>
    request<T>(endpoint, { method: 'PATCH', body: body ? JSON.stringify(body) : undefined }),
  delete: <T>(endpoint: string) => request<T>(endpoint, { method: 'DELETE' }),

  upload: async <T>(endpoint: string, form: FormData, options?: { signal?: AbortSignal }): Promise<T> => {
    const url = `${BASE_URL}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;
    const token = localStorage.getItem('radar_token');
    const uploadHeaders: Record<string, string> = {};
    if (token) uploadHeaders.Authorization = `Bearer ${token}`;

    const response = await fetch(url, {
      method: 'POST',
      body: form,
      headers: uploadHeaders,
      credentials: 'include',
      signal: options?.signal,
    });

    const contentType = response.headers.get('content-type');
    let data: any = null;
    if (contentType && contentType.includes('application/json')) {
      data = await response.json().catch(() => null);
    }

    if (!response.ok) {
      const errorInfo = data?.error;
      throw new ApiError(
        errorInfo?.message || `Upload failed with status ${response.status}`,
        errorInfo?.code || 'UPLOAD_FAILED',
        response.status,
        errorInfo?.details
      );
    }

    return (data?.data !== undefined ? data.data : data) as T;
  },

  /**
   * Resumable chunked upload for multi-GB CSV and Excel files. Slices the file into
   * 10MB parts in the browser and uploads chunks sequentially with 3-attempt retry
   * backoff, real-time byte progress, and upload speed/ETA estimation.
   */
  uploadChunked: async (
    file: File,
    options: {
      chunkSize?: number;
      onProgress?: (progress: ChunkedUploadProgress) => void;
      signal?: AbortSignal;
    } = {}
  ): Promise<ChunkedUploadResult> => {
    const token = localStorage.getItem('radar_token');
    const authHeaders: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

    // For files smaller than 10MB, single direct multipart upload is faster
    if (file.size <= 10 * 1024 * 1024) {
      const formData = new FormData();
      formData.append('file', file);
      const res = await api.upload<ChunkedUploadResult>('/campaigns/upload', formData, { signal: options.signal });
      if (options.onProgress) {
        options.onProgress({
          uploadedBytes: file.size,
          totalBytes: file.size,
          percent: 100,
          currentChunk: 1,
          totalChunks: 1,
          uploadSpeedBytesPerSecond: 0,
          estimatedRemainingSeconds: 0,
        });
      }
      return res;
    }

    const CHUNK_SIZE = options.chunkSize || 10 * 1024 * 1024; // 10 MB chunks
    const totalChunks = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));

    // 1. Initialize upload session
    const initRes = await fetch(`${BASE_URL}/campaigns/upload/init`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders,
      },
      credentials: 'include',
      signal: options.signal,
      body: JSON.stringify({
        fileName: file.name,
        fileSize: file.size,
        chunkSize: CHUNK_SIZE,
      }),
    });

    const initJson = await initRes.json();
    if (!initRes.ok) {
      throw new ApiError(
        initJson?.error?.message || 'Failed to initialize chunked upload',
        initJson?.error?.code || 'INIT_FAILED',
        initRes.status
      );
    }

    const uploadId = initJson.data.uploadId;

    // 2. Check resume status
    let alreadyReceived: Set<number> = new Set();
    try {
      const statusRes = await fetch(`${BASE_URL}/campaigns/upload/${uploadId}/status`, {
        headers: authHeaders,
        credentials: 'include',
        signal: options.signal,
      });
      if (statusRes.ok) {
        const statusJson = await statusRes.json();
        if (Array.isArray(statusJson?.data?.receivedChunks)) {
          alreadyReceived = new Set(statusJson.data.receivedChunks);
        }
      }
    } catch {
      /* continue without cached parts */
    }

    let uploadedBytes = 0;
    for (const idx of alreadyReceived) {
      uploadedBytes += Math.min(CHUNK_SIZE, file.size - idx * CHUNK_SIZE);
    }

    const startTime = Date.now();

    // 3. Upload chunk slices with retry backoff
    for (let chunkIdx = 0; chunkIdx < totalChunks; chunkIdx++) {
      if (options.signal?.aborted) {
        await fetch(`${BASE_URL}/campaigns/upload/${uploadId}`, {
          method: 'DELETE',
          headers: authHeaders,
          credentials: 'include',
        }).catch(() => {});
        throw new DOMException('Upload aborted by user', 'AbortError');
      }

      if (alreadyReceived.has(chunkIdx)) {
        continue;
      }

      const start = chunkIdx * CHUNK_SIZE;
      const end = Math.min(file.size, start + CHUNK_SIZE);
      const chunkBlob = file.slice(start, end);
      const currentChunkBytes = end - start;

      let success = false;
      let lastErr: any = null;

      for (let attempt = 1; attempt <= 3; attempt++) {
        if (options.signal?.aborted) {
          await fetch(`${BASE_URL}/campaigns/upload/${uploadId}`, {
            method: 'DELETE',
            headers: authHeaders,
            credentials: 'include',
          }).catch(() => {});
          throw new DOMException('Upload aborted by user', 'AbortError');
        }

        try {
          const chunkRes = await fetch(
            `${BASE_URL}/campaigns/upload/${uploadId}/chunk?chunkIndex=${chunkIdx}`,
            {
              method: 'PUT',
              headers: {
                'Content-Type': 'application/octet-stream',
                ...authHeaders,
              },
              credentials: 'include',
              signal: options.signal,
              body: chunkBlob,
            }
          );

          if (chunkRes.ok) {
            success = true;
            uploadedBytes += currentChunkBytes;
            break;
          } else {
            const errJson = await chunkRes.json().catch(() => null);
            lastErr = new Error(errJson?.error?.message || `Chunk ${chunkIdx} upload failed (HTTP ${chunkRes.status})`);
          }
        } catch (e: any) {
          if (e?.name === 'AbortError' || options.signal?.aborted) {
            await fetch(`${BASE_URL}/campaigns/upload/${uploadId}`, {
              method: 'DELETE',
              headers: authHeaders,
              credentials: 'include',
            }).catch(() => {});
            throw e;
          }
          lastErr = e;
        }

        // Exponential backoff retry
        await new Promise((r) => setTimeout(r, Math.min(2000, attempt * 500)));
      }

      if (!success) {
        throw new ApiError(
          lastErr?.message || `Failed to upload chunk ${chunkIdx + 1} of ${totalChunks} after 3 attempts`,
          'CHUNK_UPLOAD_FAILED',
          500
        );
      }

      const elapsedSec = Math.max(0.1, (Date.now() - startTime) / 1000);
      const speed = uploadedBytes / elapsedSec;
      const remainingBytes = Math.max(0, file.size - uploadedBytes);
      const etaSec = speed > 0 ? Math.ceil(remainingBytes / speed) : 0;
      const percent = Math.min(99, Math.round((uploadedBytes / file.size) * 1000) / 10);

      if (options.onProgress) {
        options.onProgress({
          uploadedBytes,
          totalBytes: file.size,
          percent,
          currentChunk: chunkIdx + 1,
          totalChunks,
          uploadSpeedBytesPerSecond: speed,
          estimatedRemainingSeconds: etaSec,
        });
      }
    }

    // 4. Finalize assembled file and get preview inspection
    const completeRes = await fetch(`${BASE_URL}/campaigns/upload/${uploadId}/complete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders,
      },
      credentials: 'include',
      signal: options.signal,
    });

    const completeJson = await completeRes.json();
    if (!completeRes.ok) {
      throw new ApiError(
        completeJson?.error?.message || 'Failed to finalize uploaded file',
        completeJson?.error?.code || 'FINALIZE_FAILED',
        completeRes.status
      );
    }

    if (options.onProgress) {
      options.onProgress({
        uploadedBytes: file.size,
        totalBytes: file.size,
        percent: 100,
        currentChunk: totalChunks,
        totalChunks,
        uploadSpeedBytesPerSecond: 0,
        estimatedRemainingSeconds: 0,
      });
    }

    return completeJson.data as ChunkedUploadResult;
  },
};
