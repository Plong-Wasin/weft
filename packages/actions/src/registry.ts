import type { Database } from "@weft/db";
import { createAssetActions } from "./assets";
import { createApiTokenActions } from "./api-tokens";
import { createCommentActions } from "./comments";
import { createMemberActions } from "./members";
import { createProjectActions } from "./projects";
import { createSearchActions } from "./search";
import { createWorkItemActions } from "./work-items";

/** Every Action reachable over REST and the CLI (create_workspace is a plain route with its own gates). */
export function createActionList(db: Database) {
  const members = createMemberActions(db);
  const projects = createProjectActions(db);
  const work = createWorkItemActions(db);
  const search = createSearchActions(db);
  const comments = createCommentActions(db);
  const tokens = createApiTokenActions(db);
  const assets = createAssetActions(db);
  return [
    members.listMembers, members.createInvite, members.acceptInvite, members.changeMemberRole, members.removeMember,
    projects.createProject, projects.listProjects, projects.getProject, projects.updateProject, projects.renameProjectKey,
    projects.archiveProject, projects.unarchiveProject, projects.joinProject, projects.listProjectMembers,
    projects.addProjectMember, projects.changeProjectMemberRole, projects.removeProjectMember,
    work.listStates, work.createState, work.updateState, work.reorderStates, work.deleteState, work.createWorkItem,
    work.listWorkItems, work.getWorkItem, work.updateWorkItem, work.deleteWorkItem, work.listWorkItemActivities,
    work.listSubWorkItems, work.listLabels, work.createLabel, work.updateLabel, work.deleteLabel,
    comments.listComments, comments.createComment, comments.updateComment, comments.deleteComment, comments.listMentionableMembers,
    search.searchWorkItems,
    assets.requestAssetUpload, assets.completeAssetUpload, assets.listAssets, assets.getAssetDownloadUrl, assets.deleteAsset,
    tokens.createApiToken, tokens.listApiTokens, tokens.revokeApiToken,
  ];
}
