import { defaultTypeKeyOf, translate, type MessageKey } from "@weft/shared";

/**
 * The one-line description a Work item type shows: the catalog text in the interface language while the stored text is an untouched
 * default (see defaultTypeKeyOf), otherwise the stored text exactly as typed.
 */
export function typeDescriptionText(type: { name: string; description: string }): string {
  const key = defaultTypeKeyOf(type);
  return key ? translate(`types.default.${key}` as MessageKey) : type.description;
}

/** The name of a Wiki collection. The default collection is stored as "Wiki"; the interface shows its catalog name in Thai. */
export function collectionLabel(collection: { name: string; isDefault: boolean }): string {
  return collection.isDefault && collection.name.trim() === "Wiki" ? translate("wiki.title") : collection.name;
}
