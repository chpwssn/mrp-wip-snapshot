/** Extract W Job Order numbers from text */
export function extractJobNumbers(text: string): string[] {
  if (!text) return [];
  const matches = text.match(/W\d{4,5}/g);
  return matches ? [...new Set(matches)] : [];
}

/** Extract S Sales Order numbers from text */
export function extractSalesOrderNumbers(text: string): string[] {
  if (!text) return [];
  const matches = text.match(/S\d{4,6}/g);
  return matches ? [...new Set(matches)] : [];
}

/** Extract part numbers from text (Wasson format: digits with optional dash-suffix) */
export function extractPartNumbers(text: string): string[] {
  if (!text) return [];
  // Match patterns like 12250-033, 14100-018, 88000-181, 15240, etc.
  const matches = text.match(/\b\d{4,5}-\d{2,3}\b/g);
  return matches ? [...new Set(matches)] : [];
}

/** Check if filename is an XLSX */
export function isXlsxFile(filename: string): boolean {
  return /\.xlsx?$/i.test(filename);
}

/** Check if filename is a meaningful attachment (not email signature junk) */
export function isMeaningfulAttachment(filename: string, mimeType: string): boolean {
  // Skip Outlook signature images
  if (filename.startsWith('Outlook-') && mimeType.startsWith('image/')) return false;
  // Skip generic small images (logos, icons)
  if (filename.startsWith('image00') && mimeType.startsWith('image/')) return false;
  return true;
}

/** Combine summary + description for text extraction */
export function combineText(summary?: string, description?: string): string {
  const parts: string[] = [];
  if (summary) parts.push(summary);
  if (description) parts.push(description);
  return parts.join(' ');
}
