import path from "path";

// Phase 1.5: still local-only, but now accepts uploaded skill folders in addition
// to the fixed sample set. Uploaded skills land under .uploads/<id> (gitignored)
// and are tracked in-memory for the life of the dev server process — fine for a
// prototype, not meant to survive a restart or scale past one process.
export const SAMPLE_SKILLS: Record<string, string> = {
  "benign-skill": path.join(process.cwd(), "sample-skills", "benign-skill"),
  "malicious-skill": path.join(process.cwd(), "sample-skills", "malicious-skill"),
};

export const UPLOADS_ROOT = path.join(process.cwd(), ".uploads");

const uploadedSkills = new Map<string, string>();
const uploadLabels = new Map<string, string>();
// skill-scanner requires a literal SKILL.md by default; when the uploaded entry
// file has a different name we pass --skill-file <name> instead.
const uploadSkillFile = new Map<string, string>();

export function registerUpload(id: string, dir: string, label: string, skillFile?: string): void {
  uploadedSkills.set(id, dir);
  uploadLabels.set(id, label);
  if (skillFile) uploadSkillFile.set(id, skillFile);
}

export function resolveSkillDir(skillId: string): string | null {
  if (skillId in SAMPLE_SKILLS) return SAMPLE_SKILLS[skillId];
  return uploadedSkills.get(skillId) ?? null;
}

export function uploadLabel(skillId: string): string | null {
  return uploadLabels.get(skillId) ?? null;
}

export function skillFileOverride(skillId: string): string | null {
  return uploadSkillFile.get(skillId) ?? null;
}

export function isKnownSkill(skillId: string): boolean {
  return skillId in SAMPLE_SKILLS || uploadedSkills.has(skillId);
}

// The two seeded samples are fixtures other people rely on to see a known-good /
// known-bad result — they must never be mutated by the Edit/Save flow. Anything
// editable (including a "fork" of a seed) lives in the uploads map instead.
export function isSeedSkill(skillId: string): boolean {
  return skillId in SAMPLE_SKILLS;
}
