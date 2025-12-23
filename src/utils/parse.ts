export function parseRequestContent(input: string | undefined | null): string {
  if (!input) return "";
  let result = input.trim();
  const slashIndex = result.lastIndexOf("/");
  if (slashIndex >= 0) {
    result = result.substring(slashIndex + 1);
  }
  const qIndex = result.indexOf("?");
  if (qIndex >= 0) {
    result = result.substring(0, qIndex);
  }
  return result;
}
