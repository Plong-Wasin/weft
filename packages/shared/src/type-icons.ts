/**
 * The one list of icons a Work item type can take, shared by the API (validation) and the web (rendering and the picker).
 * A key is stable and stored; the web maps each key to a drawn icon (apps/web/src/work-item-types.tsx). Keywords are English and Thai.
 * The first six keys are the original ones and keep their meaning. Names and group titles live in the catalog (types.icon.<key>, types.iconGroup.<group>).
 */
export const typeIconGroups = ["work","people","comms","status","objects","tech","nature"] as const;
export type TypeIconGroup = (typeof typeIconGroups)[number];
export type TypeIconEntry = { key: string; group: TypeIconGroup; keywords: string };

export const typeIconList = [
  { key: "task", group: "work", keywords: "todo done check tick งาน เสร็จ ทำ" },
  { key: "group", group: "work", keywords: "stack epic group parent กลุ่ม งานใหญ่" },
  { key: "document", group: "work", keywords: "file page text doc report เอกสาร รายงาน ไฟล์" },
  { key: "clipboard-list", group: "work", keywords: "clipboard list plan รายการ แผน" },
  { key: "calendar", group: "work", keywords: "date schedule event วันที่ นัด กำหนดการ" },
  { key: "flag", group: "work", keywords: "milestone priority mark เหตุการณ์สำคัญ" },
  { key: "target", group: "work", keywords: "goal objective aim goal ภารกิจ" },
  { key: "milestone", group: "work", keywords: "release version phase ไมล์สโตน ขั้น" },
  { key: "kanban", group: "work", keywords: "kanban columns cards sprint คัมบัง" },
  { key: "list-todo", group: "work", keywords: "todo backlog tasks รายการ" },
  { key: "briefcase", group: "work", keywords: "business job project ธุรกิจ งาน" },
  { key: "folder", group: "work", keywords: "directory files archive แฟ้ม" },
  { key: "book-open", group: "work", keywords: "read guide docs learning อ่าน คู่มือ" },
  { key: "pencil", group: "work", keywords: "edit write draft เขียน แก้ไข" },
  { key: "timer", group: "work", keywords: "time estimate deadline stopwatch เวลา" },
  { key: "rocket", group: "work", keywords: "launch release ship deploy เปิดตัว ปล่อย" },
  { key: "puzzle", group: "work", keywords: "integration plugin piece ปลั๊กอิน" },
  { key: "users", group: "people", keywords: "team group members ทีม สมาชิก" },
  { key: "user", group: "people", keywords: "account profile member โปรไฟล์ ผู้ใช้" },
  { key: "user-check", group: "people", keywords: "verify onboard approve ยืนยัน" },
  { key: "handshake", group: "people", keywords: "deal partner agreement ข้อตกลง พันธมิตร" },
  { key: "graduation-cap", group: "people", keywords: "learn course education เรียน อบรม" },
  { key: "heart", group: "people", keywords: "care love favourite wellbeing ใจ" },
  { key: "smile", group: "people", keywords: "feedback happy customer ความพึงพอใจ" },
  { key: "hand-helping", group: "people", keywords: "help assist care ช่วย สนับสนุน" },
  { key: "building", group: "people", keywords: "office organisation department องค์กร อาคาร" },
  { key: "crown", group: "people", keywords: "vip owner leader ผู้นำ" },
  { key: "request", group: "comms", keywords: "ask incoming intake คำขอ" },
  { key: "mail", group: "comms", keywords: "mail letter message จดหมาย" },
  { key: "message-square", group: "comms", keywords: "chat comment discuss แชต ความเห็น" },
  { key: "megaphone", group: "comms", keywords: "campaign marketing broadcast การตลาด" },
  { key: "phone", group: "comms", keywords: "call contact ติดต่อ โทร" },
  { key: "bell", group: "comms", keywords: "alert remind reminder เตือน" },
  { key: "send", group: "comms", keywords: "submit dispatch outgoing ส่งออก" },
  { key: "share", group: "comms", keywords: "distribute publish เผยแพร่" },
  { key: "newspaper", group: "comms", keywords: "article press blog บทความ" },
  { key: "mic", group: "comms", keywords: "podcast interview speak สัมภาษณ์" },
  { key: "video", group: "comms", keywords: "meeting call record ประชุม" },
  { key: "at-sign", group: "comms", keywords: "at handle email แท็ก" },
  { key: "bug", group: "status", keywords: "defect error issue fault ข้อบกพร่อง ปัญหา" },
  { key: "approval", group: "status", keywords: "approve verified sign off อนุมัติ รับรอง" },
  { key: "circle-check", group: "status", keywords: "complete success finished สำเร็จ" },
  { key: "circle-alert", group: "status", keywords: "attention warning important ข้อสังเกต" },
  { key: "triangle-alert", group: "status", keywords: "risk danger caution ความเสี่ยง อันตราย" },
  { key: "shield-check", group: "status", keywords: "safe compliance secure ปลอดภัย" },
  { key: "lock", group: "status", keywords: "private blocked secure ปิด" },
  { key: "clock", group: "status", keywords: "pending time later รอดำเนินการ" },
  { key: "zap", group: "status", keywords: "fast hotfix lightning emergency เร่งด่วน ฉุกเฉิน" },
  { key: "flame", group: "status", keywords: "critical fire burning วิกฤต" },
  { key: "star", group: "status", keywords: "favourite important highlight โปรด" },
  { key: "thumbs-up", group: "status", keywords: "like ok agree ชอบ" },
  { key: "ban", group: "status", keywords: "forbidden stop wontfix ห้าม" },
  { key: "refresh-cw", group: "status", keywords: "repeat sync loop retry วนซ้ำ" },
  { key: "hourglass", group: "status", keywords: "wait delay stalled รอคิว" },
  { key: "package", group: "objects", keywords: "parcel delivery shipment ของ" },
  { key: "box", group: "objects", keywords: "container item stock สินค้า" },
  { key: "shopping-cart", group: "objects", keywords: "order shop buy purchase สั่งซื้อ" },
  { key: "credit-card", group: "objects", keywords: "card billing pay จ่าย" },
  { key: "wallet", group: "objects", keywords: "budget money finance งบประมาณ การเงิน" },
  { key: "receipt", group: "objects", keywords: "invoice bill expense ใบแจ้งหนี้" },
  { key: "gift", group: "objects", keywords: "reward bonus promotion โปรโมชัน" },
  { key: "key", group: "objects", keywords: "access secret credential รหัส สิทธิ์" },
  { key: "wrench", group: "objects", keywords: "fix repair maintenance ซ่อม บำรุง" },
  { key: "hammer", group: "objects", keywords: "build construct tool สร้าง" },
  { key: "lightbulb", group: "objects", keywords: "suggestion proposal innovation ความคิด ข้อเสนอ" },
  { key: "camera", group: "objects", keywords: "photo picture capture ภาพถ่าย" },
  { key: "map-pin", group: "objects", keywords: "place address site ที่อยู่ ตำแหน่ง" },
  { key: "truck", group: "objects", keywords: "shipping logistics transport จัดส่ง" },
  { key: "tag", group: "objects", keywords: "label price category ป้าย" },
  { key: "code", group: "tech", keywords: "programming develop dev เขียนโปรแกรม" },
  { key: "terminal", group: "tech", keywords: "command shell cli คำสั่ง" },
  { key: "database", group: "tech", keywords: "data storage sql ข้อมูล" },
  { key: "server", group: "tech", keywords: "infrastructure host ระบบ" },
  { key: "cloud", group: "tech", keywords: "hosting saas aws ระบบคลาวด์" },
  { key: "globe", group: "tech", keywords: "website internet international เว็บไซต์ สากล" },
  { key: "cpu", group: "tech", keywords: "hardware processor performance ประสิทธิภาพ" },
  { key: "git-branch", group: "tech", keywords: "git merge version control เวอร์ชัน" },
  { key: "smartphone", group: "tech", keywords: "phone app ios android แอป" },
  { key: "monitor", group: "tech", keywords: "desktop display ui จอ" },
  { key: "wifi", group: "tech", keywords: "wireless connection internet เน็ต" },
  { key: "bot", group: "tech", keywords: "robot automation agent อัตโนมัติ" },
  { key: "sparkles", group: "tech", keywords: "ai magic new feature ฟีเจอร์ใหม่" },
  { key: "shield", group: "tech", keywords: "security protection privacy ความปลอดภัย" },
  { key: "leaf", group: "nature", keywords: "green eco sustainability สิ่งแวดล้อม" },
  { key: "tree-pine", group: "nature", keywords: "forest plant growth เติบโต" },
  { key: "sun", group: "nature", keywords: "day light bright กลางวัน" },
  { key: "moon", group: "nature", keywords: "night dark sleep กลางคืน" },
  { key: "droplet", group: "nature", keywords: "drop liquid rain หยดน้ำ" },
  { key: "mountain", group: "nature", keywords: "peak summit challenge ยอดเขา ความท้าทาย" },
  { key: "flower", group: "nature", keywords: "bloom garden spring สวน" },
  { key: "paw-print", group: "nature", keywords: "animal dog cat paw สัตว์" },
] as const satisfies ReadonlyArray<TypeIconEntry>;

export type TypeIcon = (typeof typeIconList)[number]["key"];
export const typeIcons: readonly TypeIcon[] = typeIconList.map((entry) => entry.key);
export const defaultTypeIcon: TypeIcon = "task";

/** A stored key that is not in the list falls back to the task icon. */
export function resolveTypeIcon(key: string): TypeIcon {
  return (typeIcons as readonly string[]).includes(key) ? key as TypeIcon : defaultTypeIcon;
}

/** The icons whose name (as shown), key or keywords contain every word of the query, case-insensitively. An empty query matches all. */
export function searchTypeIcons(query: string, nameOf: (key: TypeIcon) => string): ReadonlyArray<(typeof typeIconList)[number]> {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return typeIconList;
  return typeIconList.filter((entry) => {
    const text = `${nameOf(entry.key)} ${entry.key.replace(/-/g, " ")} ${entry.keywords}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
}
