import { jsonOk, type IRequest, type IResponse } from "./server-common";
import { projectFolders } from "./project-index";

// GET /projects: the known projects, for the schedule form's new-thread
// target. Read-only: it reads the index as it stands and never starts a
// workspace scan (that stays with Jarvis's list_projects). Adding a folder
// has no route yet.

export async function handleProjectRoutes(req: IRequest, res: IResponse): Promise<boolean> {
  const path = (req.url ?? "/").split("?")[0];
  if (path !== "/projects" || (req.method ?? "GET") !== "GET") return false;
  jsonOk(res, { projects: projectFolders() });
  return true;
}
