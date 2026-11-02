/** A token needs an expiry date unless the user explicitly chooses never. */
export function hasValidTokenExpiry(expiresAt: string, neverExpires: boolean): boolean {
  return neverExpires || expiresAt.length > 0;
}
