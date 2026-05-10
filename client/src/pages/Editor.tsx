import { Navigate, useParams } from "react-router-dom";
import EditorApp from "../EditorApp";

export function EditorPage() {
  const { id } = useParams<{ id: string }>();
  const projectId = Number(id);
  if (!Number.isFinite(projectId) || projectId <= 0) {
    return <Navigate to="/" replace />;
  }
  return <EditorApp projectId={projectId} />;
}
