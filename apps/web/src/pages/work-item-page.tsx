import { useParams } from "react-router";
import { WorkItemDetail } from "../work-item-detail";

/** The full page of a work item at the browse-by-key URL. */
export function WorkItemPage() {
  const { displayId = "" } = useParams();
  return <WorkItemDetail key={displayId} displayId={displayId} mode="page" />;
}
