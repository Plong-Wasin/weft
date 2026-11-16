import type { Database } from "@weft/db";
import { createAgentActions } from "./agents";
import { createAnalyticsActions } from "./analytics";
import { createRunActions } from "./runs";
import { createAssetActions } from "./assets";
import { createApiTokenActions } from "./api-tokens";
import { createCycleActions } from "./cycles";
import { createTimelineActions } from "./timeline";
import { createCommentActions } from "./comments";
import { createEstimateActions } from "./estimates";
import { createExportActions } from "./exports";
import { createIntakeActions } from "./intake";
import { createLocaleActions } from "./locale";
import { createEmailPreferenceActions } from "./email-preferences";
import { createModuleActions } from "./modules";
import { createMemberActions } from "./members";
import { createNotificationActions } from "./notifications";
import { createProjectActions } from "./projects";
import { createRelationActions } from "./relations";
import { createSearchActions } from "./search";
import { createViewActions } from "./views";
import { createWikiActions } from "./wiki";
import { createWorkItemActions } from "./work-items";
import { createWorkItemArchiveActions } from "./work-item-archive";
import { createWebLinkActions } from "./web-links";
import { createSkillActions } from "./skills";
import { createRuntimeActions } from "./runtimes";
import { createAutopilotSettingActions } from "./autopilot-settings";
import { createTriggerActions } from "./triggers";
import { createRecurrenceActions } from "./recurrences";
import { createAdminConsoleActions } from "./admin-console";
import { createWorkItemIntegrationActions, integrationActionNames } from "./work-item-integrations";
import { integrationsEnabled } from "./integration-flag";

/** Every Action reachable over REST and the CLI (create_workspace is a plain route with its own gates). */
export function createActionList(db: Database, options: { integrations?: boolean; passwordSignInEnabled?: boolean } = {}) {
  const members = createMemberActions(db);
  const projects = createProjectActions(db);
  const work = createWorkItemActions(db);
  const archive = createWorkItemArchiveActions(db);
  const search = createSearchActions(db);
  const comments = createCommentActions(db);
  const timeline = createTimelineActions(db);
  const relations = createRelationActions(db);
  const tokens = createApiTokenActions(db);
  const assets = createAssetActions(db);
  const wiki = createWikiActions(db);
  const inbox = createNotificationActions(db);
  const locale = createLocaleActions(db);
  const emailPreferences = createEmailPreferenceActions(db);
  const cycles = createCycleActions(db);
  const modules = createModuleActions(db);
  const intake = createIntakeActions(db);
  const estimates = createEstimateActions(db);
  const views = createViewActions(db);
  const web = createWebLinkActions(db);
  const agents = createAgentActions(db);
  const runs = createRunActions(db);
  const skills = createSkillActions(db);
  const runtimes = createRuntimeActions(db);
  const triggers = createTriggerActions(db);
  const recurrences = createRecurrenceActions(db);
  const integrations = createWorkItemIntegrationActions(db);
  const analytics = createAnalyticsActions(db);
  const exportActions = createExportActions(db);
  const autopilot = createAutopilotSettingActions(db);
  const admin = createAdminConsoleActions(db, undefined, { passwordSignInEnabled: options.passwordSignInEnabled });
  const all = [autopilot.getAutopilotSetting, autopilot.setAutopilotSetting, autopilot.getRuntimeRunLimits, autopilot.setRuntimeRunLimits,
    admin.listMemberAccounts, admin.suspendMember, admin.reactivateMember, admin.signOutMember, admin.forcePasswordReset, admin.cancelForcedPasswordReset, admin.listMemberApiTokens, admin.revokeMemberApiToken,
    admin.listAuditLog, admin.exportAuditLog, admin.listMySessions, admin.revokeMySession, admin.signOutEverywhere, admin.acknowledgeSecurityNotice,
    members.listMembers, members.createInvite, members.listOpenInvites, members.revokeInvite, members.acceptInvite, members.changeMemberRole, members.removeMember,
    projects.createProject, projects.listProjects, projects.getProject, projects.updateProject, projects.renameProjectKey,
    projects.setProjectFeatures, projects.archiveProject, projects.unarchiveProject, projects.joinProject, projects.listProjectMembers,
    projects.addProjectMember, projects.changeProjectMemberRole, projects.removeProjectMember,
    work.listStates, work.createState, work.updateState, work.reorderStates, work.deleteState, work.createWorkItem,
    work.listWorkItems, work.listWorkspaceWorkItems, work.moveWorkItem, work.getWorkItem, work.updateWorkItem, work.bulkUpdateWorkItems, work.deleteWorkItem, work.deleteWorkItems, work.listWorkItemDescriptionVersions, work.restoreWorkItemDescriptionVersion, work.listWorkItemActivities,
    work.listSubWorkItems, archive.archiveWorkItem, archive.bulkArchiveWorkItems, archive.restoreWorkItem, work.listLabels, work.createLabel, work.updateLabel, work.deleteLabel,
    comments.listComments, comments.createComment, comments.updateComment, comments.deleteComment, comments.listMentionableMembers, comments.listCommentVersions, timeline.listTimeline,
    relations.listWorkItemRelations, relations.createWorkItemRelation, relations.removeWorkItemRelation,
    web.listWebLinks, web.createWebLink, web.updateWebLink, web.deleteWebLink,
    integrations.listWorkItemPullRequests, integrations.listWorkItemIntegrations, integrations.createWorkItemIntegration, integrations.updateWorkItemIntegration, integrations.rotateWorkItemIntegrationSecret, integrations.getProjectMergedPrSetting, integrations.setProjectMergedPrSetting,
    search.searchWorkItems,
    assets.requestAssetUpload, assets.completeAssetUpload, assets.listAssets, assets.getAssetDownloadUrl, assets.deleteAsset,
    wiki.createWikiPageTemplate, wiki.listWikiPageTemplates, wiki.deleteWikiPageTemplate,
    wiki.createCollection, wiki.listCollections, wiki.renameCollection, wiki.setCollectionVisibility, wiki.shareCollection, wiki.listCollectionMembers, wiki.revokeCollectionShare, wiki.deleteCollection,
    wiki.createWikiPage, wiki.listWikiPages, wiki.listSharedWikiPages, wiki.listWikiPageShares, wiki.shareWikiPage, wiki.revokeWikiPageShare, wiki.listFavoriteWikiPages, wiki.favoriteWikiPage, wiki.getWikiPage, wiki.getWikiPageAccess, wiki.lockWikiPage, wiki.unlockWikiPage, wiki.updateWikiPage, wiki.archiveWikiPage, wiki.unarchiveWikiPage, wiki.listWikiPageMentionableMembers, wiki.moveWikiPage, wiki.getPageMoveImpact, wiki.movePageScope, wiki.setWikiPageAccess, wiki.publishWikiPage, wiki.revokeWikiPagePublishedLink,
    wiki.linkWorkItemPage, wiki.unlinkWorkItemPage, wiki.listWorkItemPages, wiki.listWikiPageWorkItems,
    wiki.createWikiPageComment, wiki.listWikiPageComments, wiki.replyWikiPageComment, wiki.updateWikiPageComment, wiki.resolveWikiPageComment,
    wiki.deleteWikiPage, wiki.duplicateWikiPage, wiki.listWikiPageVersions, wiki.restoreWikiPageVersion, wiki.searchWikiPages, wiki.listWikiPageActivities, wiki.listProjectWikiPages,
    inbox.listNotifications, inbox.markNotificationRead, inbox.markAllNotificationsRead,
    tokens.createApiToken, tokens.listApiTokens, tokens.revokeApiToken, tokens.listAuthorizedApps, tokens.revokeAuthorizedApp,
    cycles.createCycle, cycles.updateCycle, cycles.listCycles, cycles.getCycle, cycles.getCycleBurndown, cycles.checkCycleDates, cycles.addCycleItems, cycles.removeCycleItems, cycles.transferCycleItems, cycles.archiveCycle, cycles.unarchiveCycle, cycles.deleteCycle,
    modules.createModule, modules.updateModule, modules.listModules, modules.getModule, modules.getModuleBurndown, modules.addModuleItems, modules.removeModuleItems, modules.archiveModule, modules.unarchiveModule, modules.deleteModule,
    intake.submitIntakeItem, intake.listIntakeItems, intake.updateIntakeItem, intake.acceptIntakeItem, intake.rejectIntakeItem, intake.snoozeIntakeItem, intake.duplicateIntakeItem,
    estimates.getEstimate, estimates.createEstimate, estimates.updateEstimate, estimates.deleteEstimatePoint, estimates.getEstimateUsage, estimates.switchEstimateType, estimates.deleteEstimate,
    views.createView, views.updateView, views.deleteView, views.listViews, views.getView, views.createWorkspaceView, views.listWorkspaceViews,
    locale.getMyLocale, locale.setMyLocale,
    emailPreferences.getMyEmailPreferences, emailPreferences.setMyEmailPreferences,
    agents.listAgents, agents.listManageableAgentAccess, agents.listAgentsForViewer, agents.setAgentRuntimeProfile, agents.getAgent, agents.createAgent, agents.updateAgent, agents.enableAgent, agents.disableAgent, agents.deleteAgent, agents.setAgentProjectAccess, agents.setAgentAccess, agents.setAgentSkills,
    runtimes.registerDaemon, runtimes.listRuntimes, runtimes.listRuntimeProfiles, runtimes.createRuntimeProfile, runtimes.updateRuntimeProfile, runtimes.deleteRuntimeProfile, runtimes.setRuntimeSandboxEnforcement, runtimes.shareRuntime, runtimes.unshareRuntime,
    analytics.getAnalyticsSummary, analytics.getAnalyticsInsights, analytics.getAnalyticsOverview, analytics.getCreatedVsResolved,
    exportActions.requestExport, exportActions.listExports, exportActions.getExportDownloadUrl,
    runs.listRuns, runs.listAgentRuns, runs.getRun, runs.getRunTranscript, runs.cancelRun, runs.rerunRun,
    skills.listSkills, skills.getSkill, skills.createSkill, skills.updateSkill, skills.deleteSkill, skills.listSkillAgents,
    triggers.createTrigger, triggers.updateTrigger, triggers.pauseTrigger, triggers.deleteTrigger, triggers.listTriggers,
    recurrences.createRecurrence, recurrences.updateRecurrence, recurrences.pauseRecurrence, recurrences.resumeRecurrence, recurrences.deleteRecurrence, recurrences.runRecurrenceNow, recurrences.getRecurrence, recurrences.listRecurrences,
  ];
  const showIntegrations = options.integrations ?? integrationsEnabled();
  const hidden = new Set<string>(integrationActionNames);
  return showIntegrations ? all : all.filter((action) => !hidden.has(action.name));
}
