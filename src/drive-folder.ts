/**
 * Parse a Drive folder URL or raw ID into a canonical folder ID.
 *
 * Accepts any of:
 *   - Raw ID:            1AbC_defGhIjKlMnOpQrStUv
 *   - Shared link:       https://drive.google.com/drive/folders/<id>
 *   - Account-scoped:    https://drive.google.com/drive/u/0/folders/<id>
 *   - With query:        .../folders/<id>?usp=sharing
 *
 * Returns null if we can't find a folder-ID-shaped token.
 */
const ID_PATTERN = /^[a-zA-Z0-9_-]{10,}$/;

export function parseFolderInput(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (ID_PATTERN.test(trimmed)) return trimmed;
  const m = trimmed.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (m?.[1] && ID_PATTERN.test(m[1])) return m[1];
  return null;
}
