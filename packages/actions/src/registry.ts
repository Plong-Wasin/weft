import type { Database } from "@weft/db";
import { createAssetActions } from "./assets";
import { createApiTokenActions } from "./api-tokens";
import { createCommentActions } from "./comments";
import { createLocaleActions } from "./locale";
import { createMemberActions } from "./members";
import { createNotificationActions } from "./notifications";
import { createProjectActions } from "./projects";
import { createSearchActions } from "./search";
import { createWikiActions } from "./wiki";
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
  const wiki = createWikiActions(db);
  const inbox = createNotificationActions(db);
  const locale = createLocaleActions(db);
  return [
    members.listMembers, members.createInvite, members.listOpenInvites, members.revokeInvite, members.acceptInvite, members.changeMemberRole, members.removeMember,
    projects.createProject, projects.listProjects, projects.getProject, projects.updateProject, projects.renameProjectKey,
    projects.archiveProject, projects.unarchiveProject, projects.joinProject, projects.listProjectMembers,
    projects.addProjectMember, projects.changeProjectMemberRole, projects.removeProjectMember,
    work.listStates, work.createState, work.updateState, work.reorderStates, work.deleteState, work.createWorkItem,
    work.listWorkItems, work.moveWorkItem, work.getWorkItem, work.updateWorkItem, work.deleteWorkItem, work.listWorkItemActivities,
    work.listSubWorkItems, work.listLabels, work.createLabel, work.updateLabel, work.deleteLabel,
    comments.listComments, comments.createComment, comments.updateComment, comments.deleteComment, comments.listMentionableMembers,
    search.searchWorkItems,
    assets.requestAssetUpload, assets.completeAssetUpload, assets.listAssets, assets.getAssetDownloadUrl, assets.deleteAsset,
    wiki.createWikiPage, wiki.listWikiPages, wiki.getWikiPage, wiki.updateWikiPage, wiki.moveWikiPage, wiki.setWikiPageAccess,
    wiki.deleteWikiPage, wiki.listWikiPageVersions, wiki.restoreWikiPageVersion, wiki.acquireWikiLock, wiki.releaseWikiLock, wiki.searchWikiPages, wiki.listWikiPageActivities,
    inbox.listNotifications, inbox.markNotificationRead, inbox.markAllNotificationsRead,
    tokens.createApiToken, tokens.listApiTokens, tokens.revokeApiToken,
    locale.getMyLocale, locale.setMyLocale,
  ];
}
