/**
 * Wraps retrieved workspace content so the model can tell data from instructions. The random id
 * in the markers means stored text cannot forge the closing marker.
 */
export function wrapRetrieved(tool: string, result: unknown) {
  const id = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
  return `<<<RETRIEVED_DATA tool=${tool} id=${id}>>>\n${JSON.stringify(result ?? null)}\n<<<END_RETRIEVED_DATA id=${id}>>>`;
}
