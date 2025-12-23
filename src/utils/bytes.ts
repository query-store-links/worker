export function formatBytes(bytes: number): string {
  const KB = 1024;
  const MB = KB * 1024;
  const GB = MB * 1024;
  const TB = GB * 1024;

  if (bytes >= TB) return (bytes / TB).toFixed(2).replace(/\.00$/, "") + " TB";
  if (bytes >= GB) return (bytes / GB).toFixed(2).replace(/\.00$/, "") + " GB";
  if (bytes >= MB) return (bytes / MB).toFixed(2).replace(/\.00$/, "") + " MB";
  if (bytes >= KB) return (bytes / KB).toFixed(2).replace(/\.00$/, "") + " KB";
  return `${bytes} B`;
}
