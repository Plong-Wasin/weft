// Shared navigation helpers for the Playwright journeys. They know where each destination lives in the
// redesigned shell: the sidebar on desktop, the bottom tabs and the Menu sheet on a phone-width viewport.

export const isNarrow = (page) => (page.viewportSize()?.width ?? 1280) <= 760;

/** Opens the Menu dialog (Skills, Settings, Templates, Keyboard shortcuts, Sign out; destinations on a phone). */
export async function openMenu(page) {
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Menu' });
  await dialog.waitFor();
  return dialog;
}

const MENU_DESTINATIONS = new Set(['Settings', 'Skills']);
const PHONE_MENU_DESTINATIONS = new Set(['All tasks', 'Blockers', 'Overview', 'Milestones', 'Knowledge']);

/** Goes to a destination by its visible name: Inbox, My work, All tasks, Proposals, Blockers, Overview, Milestones, Knowledge, Skills, Settings. */
export async function goTo(page, name) {
  if (MENU_DESTINATIONS.has(name) || (isNarrow(page) && PHONE_MENU_DESTINATIONS.has(name))) {
    const dialog = await openMenu(page);
    await dialog.getByRole('button', { name, exact: true }).click();
    return;
  }
  const scope = isNarrow(page) ? page.locator('.mobile-tabs') : page.locator('.sidebar');
  await scope.getByRole('button', { name, exact: true }).click();
}

/** The Task detail panel (or sheet on a phone); pass a number to wait for that Task. */
export const taskPanel = (page, number) => page.getByRole('region', { name: number === undefined ? /^Task #\d+$/ : `Task #${number}` });

/** Creates a Project through the Projects "+" button and its dialog (workspace admins only). */
export async function createProject(page, name) {
  await page.locator('.sidebar').getByRole('button', { name: 'New Project' }).click();
  const dialog = page.getByRole('dialog', { name: 'New Project' });
  await dialog.getByLabel('New Project name').fill(name);
  await dialog.getByRole('button', { name: 'Create Project' }).click();
  await dialog.waitFor({ state: 'hidden' });
}

/** Opens the New task dialog from the top bar. */
export async function openNewTask(page) {
  await page.locator('header.topbar').getByRole('button', { name: 'New task' }).click();
  const dialog = page.getByRole('dialog', { name: 'New task' });
  await dialog.waitFor();
  return dialog;
}

/** Creates a Task through the New task dialog; the Task detail panel opens afterwards. */
export async function createTaskInUi(page, title, { project } = {}) {
  const dialog = await openNewTask(page);
  if (project) await dialog.getByLabel('Project', { exact: true }).selectOption({ label: project });
  await dialog.getByLabel('Task title').fill(title);
  await dialog.getByRole('button', { name: 'Create task' }).click();
  await dialog.waitFor({ state: 'hidden' });
}

/** Switches the Tasks view (Table, Kanban, Calendar, Timeline) on desktop (segmented control) or phone (dropdown). */
export async function setView(page, view) {
  if (isNarrow(page)) {
    await page.getByRole('button', { name: /^Task views/ }).click();
    await page.getByRole('menuitemradio', { name: view, exact: true }).click();
  } else {
    await page.getByRole('group', { name: 'Task views' }).getByRole('button', { name: view, exact: true }).click();
  }
}
