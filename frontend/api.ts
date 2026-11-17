export const message = (error: unknown) => error instanceof Error ? error.message : 'Unbekannter Fehler.';
export const post = (body: object): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, options);
  const body: unknown = await response.json();
  if (!response.ok) {
    const detail = typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string'
      ? body.error : `Anfrage fehlgeschlagen (${response.status}).`;
    throw new Error(detail);
  }
  return body as T;
}

export const seriesKey = (device: string, sensor: string) => JSON.stringify([device, sensor]);
