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

export function registerUpload(id: string, dir: string, label: string): void {
  uploadedSkills.set(id, dir);
  uploadLabels.set(id, label);
}

export function resolveSkillDir(skillId: string): string | null {
  if (skillId in SAMPLE_SKILLS) return SAMPLE_SKILLS[skillId];
  return uploadedSkills.get(skillId) ?? null;
}

export function uploadLabel(skillId: string): string | null {
  return uploadLabels.get(skillId) ?? null;
}

export function isKnownSkill(skillId: string): boolean {
  return skillId in SAMPLE_SKILLS || uploadedSkills.has(skillId);
}
