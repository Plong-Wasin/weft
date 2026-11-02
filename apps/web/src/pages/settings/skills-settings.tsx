import React from "react";
import { translate } from "@weft/shared";
import { action, actionResult } from "../../api";
import { useWorkspace } from "../../layouts/workspace-layout";
import type { Member } from "../../types";
import { validateSkillDraft, type SkillDraft } from "../../skills-form";
import { Note, Row, RowList, SettingsBlock, SettingsHeader } from "./settings-ui";

type Skill = { id: string; name: string; description: string; scope: "personal" | "workspace"; instructions?: string };
const blank: SkillDraft = { name: "", description: "", instructions: "" };

function SkillEditor({ draft, onChange, onSubmit, onCancel }: { draft: SkillDraft; onChange: (value: SkillDraft) => void; onSubmit: () => void; onCancel?: () => void }) {
  const set = (key: keyof SkillDraft) => (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange({ ...draft, [key]: event.target.value });
  return <form className="grid gap-3" onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
    <label>{translate("skills.name")}<input maxLength={64} value={draft.name} onChange={set("name")} aria-describedby="skill-name-hint" /></label>
    <p id="skill-name-hint" className="text-13 text-secondary">{translate("skills.nameHint")}</p>
    <label>{translate("skills.descriptionField")}<textarea maxLength={1024} rows={2} value={draft.description} onChange={set("description")} /></label>
    <label>{translate("skills.instructions")}<textarea maxLength={8000} rows={5} value={draft.instructions} onChange={set("instructions")} /></label>
    <div className="flex gap-2"><button type="submit">{translate("skills.save")}</button>{onCancel && <button type="button" className="secondary" onClick={onCancel}>{translate("agents.cancel")}</button>}</div>
  </form>;
}

/** Personal Skills are private to their owner; only workspace admins can change Workspace Skills. */
export function WorkspaceSkills() {
  const { workspace, selfId } = useWorkspace();
  const [role, setRole] = React.useState<Member["role"] | null>(null);
  const [tab, setTab] = React.useState<"personal" | "workspace">("personal");
  const [skills, setSkills] = React.useState<Skill[]>([]);
  const [editor, setEditor] = React.useState<{ id?: string; draft: SkillDraft } | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  const [error, setError] = React.useState(false);
  const canPersonal = role !== null && role !== "Guest";
  const isAdmin = role === "Admin";
  const load = React.useCallback(async () => {
    const members = await action<Member[]>("list_members", { workspaceId: workspace.id }) ?? [];
    setRole(members.find((member) => member.userId === selfId)?.role ?? null);
    setSkills(await action<Skill[]>("list_skills", { workspaceId: workspace.id }) ?? []);
  }, [workspace.id, selfId]);
  React.useEffect(() => { void load(); }, [load]);
  const visible = skills.filter((skill) => skill.scope === tab);
  const say = (text: string, failed = false) => { setNote(text); setError(failed); };
  const messageFor = (reason: string): string => {
    if (reason.includes("already exists")) return translate("skills.duplicate");
    return translate("skills.failed");
  };
  const save = async () => {
    if (!editor) return;
    const invalid = validateSkillDraft(editor.draft);
    if (invalid) { say(translate(invalid), true); return; }
    const result = await actionResult<Skill>(editor.id ? "update_skill" : "create_skill", editor.id
      ? { skillId: editor.id, ...editor.draft }
      : { workspaceId: workspace.id, scope: tab, ...editor.draft });
    if ("error" in result) { say(messageFor(result.error), true); return; }
    setEditor(null); say(translate("skills.saved")); await load();
  };
  const edit = async (skill: Skill) => {
    const full = await action<Skill>("get_skill", { skillId: skill.id });
    if (full) setEditor({ id: skill.id, draft: { name: full.name, description: full.description, instructions: full.instructions ?? "" } });
    else say(translate("skills.failed"), true);
  };
  const remove = async (skill: Skill) => {
    if (!window.confirm(translate("skills.deleteConfirm"))) return;
    const result = await actionResult("delete_skill", { skillId: skill.id });
    if ("error" in result) { say(translate("skills.failed"), true); return; }
    say(translate("skills.deleted")); await load();
  };
  return <section>
    <SettingsHeader title={translate("skills.title")} description={translate("skills.description")} />
    <div role="tablist" aria-label={translate("skills.title")} className="mb-4 flex gap-2">
      {(["personal", "workspace"] as const).map((scope) => <button type="button" role="tab" aria-selected={tab === scope} key={scope} className={tab === scope ? "" : "secondary"} onClick={() => { setTab(scope); setEditor(null); setNote(null); }}>{translate(`skills.${scope}`)}</button>)}
    </div>
    {tab === "workspace" && !isAdmin && <p className="mb-3 text-13 text-secondary">{translate("skills.readOnly")}</p>}
    {role === "Guest" && tab === "personal" && <p className="mb-3 text-13 text-secondary">{translate("skills.guestReadOnly")}</p>}
    {!editor && ((tab === "personal" && canPersonal) || (tab === "workspace" && isAdmin)) && <SettingsBlock title={translate("skills.create")}>
      <button type="button" onClick={() => { setNote(null); setEditor({ draft: blank }); }}>{translate("skills.create")}</button>
    </SettingsBlock>}
    {editor && <SettingsBlock title={editor.id ? translate("skills.edit") : translate("skills.create")}>
      <SkillEditor draft={editor.draft} onChange={(draft) => setEditor({ ...editor, draft })} onSubmit={() => void save()} onCancel={() => setEditor(null)} />
    </SettingsBlock>}
    <SettingsBlock>
      {visible.length === 0 ? <p className="text-secondary">{translate("skills.none")}</p> : <RowList>{visible.map((skill) => <Row key={skill.id}>
        <div className="grid min-w-0 flex-1 gap-1"><span className="font-medium">{skill.name}</span><span className="text-13 text-secondary">{skill.description}</span></div>
        {(tab === "personal" || isAdmin) && <div className="flex gap-2"><button type="button" className="secondary" onClick={() => void edit(skill)}>{translate("skills.edit")}</button><button type="button" className="secondary" onClick={() => void remove(skill)}>{translate("skills.delete")}</button></div>}
      </Row>)}</RowList>}
    </SettingsBlock>
    <Note note={note} error={error} />
  </section>;
}
