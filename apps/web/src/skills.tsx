import React from 'react';
import type { App } from './app-state';
import { api } from './api';
import type { Skill } from './types';

function renderSkillBody(body: string, workspaceId: string) {
  const parts = body.split(/(#[0-9]+|@[A-Za-z0-9_-]+)/g);
  return parts.map((part, index) => {
    if (/^#[0-9]+$/.test(part)) return <a key={index} href={`/w/${workspaceId}/tasks/${part.slice(1)}`}>{part}</a>;
    if (/^@[A-Za-z0-9_-]+$/.test(part)) return <a key={index} href={`/w/${workspaceId}/teams?name=${encodeURIComponent(part.slice(1))}`}>{part}</a>;
    return <React.Fragment key={index}>{part.split('\n').map((line, lineIndex) => <React.Fragment key={lineIndex}>{lineIndex > 0 && <br />}{line}</React.Fragment>)}</React.Fragment>;
  });
}

export function SkillsScreen({ app }: { app: App }) {
  const { archiveSkill, editingSkill, openSkill, saveSkill, selectedSkill, setEditingSkill, setError, setSelectedSkill, setSkillDraft, setSkills, skillDraft, skills, workspace } = app;
  return <section className="skill-browser" aria-label="Workspace Skills"><aside><h2>Skills</h2><ul>{skills.map((skill) => <li key={skill.id}><button type="button" className="link-button" onClick={() => openSkill(skill)}><strong>{skill.name}{!skill.enabled && ' · Disabled'}</strong><span className="muted">{skill.description}</span></button></li>)}</ul>{['owner','admin'].includes(workspace?.role ?? '') && <button type="button" onClick={() => { setSelectedSkill(null); setSkillDraft({ name: '', description: '', body: '' }); setEditingSkill(true); }}>Create Skill</button>}</aside>
      <div className="skill-content">{editingSkill ? <form className="task-form" onSubmit={saveSkill}><h2>{selectedSkill ? 'Edit Skill' : 'New Skill'}</h2><p className="notice">Everyone in this Workspace, including Viewers, and the AI can read enabled Skills. Never include passwords, tokens, or other secrets.</p><label>Name<input value={skillDraft.name} onChange={(event) => setSkillDraft({ ...skillDraft, name: event.target.value })} required /></label><label>Short description<input value={skillDraft.description} onChange={(event) => setSkillDraft({ ...skillDraft, description: event.target.value })} required maxLength={300} /></label><label>Markdown body<textarea rows={16} value={skillDraft.body} onChange={(event) => setSkillDraft({ ...skillDraft, body: event.target.value })} /></label><div className="actions"><button>Save Skill</button><button type="button" className="secondary" onClick={() => setEditingSkill(false)}>Cancel</button></div></form> : selectedSkill ? <article><h2>{selectedSkill.name}{!selectedSkill.enabled && ' · Disabled'}</h2><p className="muted">{selectedSkill.description}</p><div className="skill-markdown">{renderSkillBody(selectedSkill.body ?? '', workspace!.id)}</div>{['owner','admin'].includes(workspace?.role ?? '') && <div className="actions"><button type="button" onClick={() => { setSkillDraft({ name: selectedSkill.name, description: selectedSkill.description, body: selectedSkill.body ?? '' }); setEditingSkill(true); }}>Edit</button><button type="button" className="secondary" onClick={() => void api<Skill>(`/workspaces/${workspace!.id}/skills/${selectedSkill.id}`, { method: 'PATCH', body: JSON.stringify({ expected_version: selectedSkill.version, enabled: !selectedSkill.enabled }) }).then((saved) => { setSelectedSkill({ ...selectedSkill, ...saved }); setSkills((items) => items.map((item) => item.id === saved.id ? saved : item)); }).catch((reason) => setError(reason instanceof Error ? reason.message : 'Could not update Skill.'))}>{selectedSkill.enabled ? 'Disable' : 'Enable'}</button>{selectedSkill.enabled && <button type="button" className="danger" onClick={() => void archiveSkill()}>Archive</button>}</div>}</article> : <p className="muted">Choose a Skill to read it.</p>}</div>
    </section>;
}
