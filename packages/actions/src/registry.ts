import type { Database } from "@weft/db";
import { createAssetActions } from "./assets";
import { createApiTokenActions } from "./api-tokens";
import { createCycleActions } from "./cycles";
import { createTimelineActions } from "./timeline";
import { createCommentActions } from "./comments";
import { createIntakeActions } from "./intake";
import { createLocaleActions } from "./locale";
import { createModuleActions } from "./modules";
import { createMemberActions } from "./members";
import { createNotificationActions } from "./notifications";
import { createProjectActions } from "./projects";
import { createRelationActions } from "./relations";
import { createSearchActions } from "./search";
import { createViewActions } from "./views";
import { createWikiActions } from "./wiki";
import { createWorkItemActions } from "./work-items";

/** Every Action reachable over REST and the CLI (create_workspace is a plain route with its own gates). */
export function createActionList(db: Database) {
  const members = createMemberActions(db);
  const projects = createProjectActions(db);
  const work = createWorkItemActions(db);
  const search = createSearchActions(db);
  const comments = createCommentActions(db);
  const timeline = createTimelineActions(db);
  const relations = createRelationActions(db);
  const tokens = createApiTokenActions(db);
  const assets = createAssetActions(db);
  const wiki = createWikiActions(db);
  const inbox = createNotificationActions(db);
  const locale = createLocaleActions(db);
  const cycles = createCycleActions(db);
  const modules = createModuleActions(db);
  const intake = createIntakeActions(db);
  const views = createViewActions(db);
  return [
    members.listMembers, members.createInvite, members.listOpenInvites, members.revokeInvite, members.acceptInvite, members.changeMemberRole, members.removeMember,
    projects.createProject, projects.listProjects, projects.getProject, projects.updateProject, projects.renameProjectKey,
    projects.setProjectFeatures, projects.archiveProject, projects.unarchiveProject, projects.joinProject, projects.listProjectMembers,
    projects.addProjectMember, projects.changeProjectMemberRole, projects.removeProjectMember,
    work.listStates, work.createState, work.updateState, work.reorderStates, work.deleteState, work.createWorkItem,
    work.listWorkItems, work.listWorkspaceWorkItems, work.moveWorkItem, work.getWorkItem, work.updateWorkItem, work.deleteWorkItem, work.listWorkItemActivities,
    work.listSubWorkItems, work.listLabels, work.createLabel, work.updateLabel, work.deleteLabel,
    comments.listComments, comments.createComment, comments.updateComment, comments.deleteComment, comments.listMentionableMembers, comments.listCommentVersions, timeline.listTimeline,
    relations.listWorkItemRelations, relations.createWorkItemRelation, relations.removeWorkItemRelation,
    search.searchWorkItems,
    assets.requestAssetUpload, assets.completeAssetUpload, assets.listAssets, assets.getAssetDownloadUrl, assets.deleteAsset,
    wiki.createWikiPage, wiki.listWikiPages, wiki.getWikiPage, wiki.updateWikiPage, wiki.moveWikiPage, wiki.setWikiPageAccess,
    wiki.deleteWikiPage, wiki.listWikiPageVersions, wiki.restoreWikiPageVersion, wiki.acquireWikiLock, wiki.releaseWikiLock, wiki.searchWikiPages, wiki.listWikiPageActivities, wiki.linkWikiPageToProject, wiki.unlinkWikiPageFromProject, wiki.listWikiPageProjects, wiki.listProjectWikiPages,
    inbox.listNotifications, inbox.markNotificationRead, inbox.markAllNotificationsRead,
    tokens.createApiToken, tokens.listApiTokens, tokens.revokeApiToken, tokens.listAuthorizedApps, tokens.revokeAuthorizedApp,
    cycles.createCycle, cycles.updateCycle, cycles.listCycles, cycles.getCycle, cycles.checkCycleDates, cycles.addCycleItems, cycles.removeCycleItems, cycles.transferCycleItems, cycles.archiveCycle, cycles.deleteCycle,
    modules.createModule, modules.updateModule, modules.listModules, modules.getModule, modules.addModuleItems, modules.removeModuleItems, modules.archiveModule, modules.unarchiveModule, modules.deleteModule,
    intake.submitIntakeItem, intake.listIntakeItems, intake.updateIntakeItem, intake.acceptIntakeItem, intake.rejectIntakeItem, intake.snoozeIntakeItem, intake.duplicateIntakeItem,
    views.createView, views.updateView, views.deleteView, views.listViews, views.getView, views.createWorkspaceView, views.listWorkspaceViews,
    locale.getMyLocale, locale.setMyLocale,
  ];
}
