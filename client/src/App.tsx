import { Navigate, Route, Routes, Link } from "react-router-dom";
import { AuthProvider, useAuth } from "./api/auth-context";
import { LoginPage } from "./pages/Login";
import { RegisterPage } from "./pages/Register";
import { SetupPage } from "./pages/Setup";
import { ForgotPasswordPage } from "./pages/ForgotPassword";
import { ProjectsPage } from "./pages/Projects";
import { EditorPage } from "./pages/Editor";
import { AdminPage } from "./pages/Admin";

export function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/setup"     element={<SetupPage />} />
        <Route path="/login"     element={<LoginPage />} />
        <Route path="/register"  element={<RegisterPage />} />
        <Route path="/forgot"    element={<ForgotPasswordPage />} />

        <Route path="/"          element={<Authed><ProjectsPage /></Authed>} />
        <Route path="/p/:id"     element={<Authed><EditorPage /></Authed>} />
        <Route path="/admin/*"   element={<AdminGuard><AdminPage /></AdminGuard>} />

        <Route path="*"          element={<NotFound />} />
      </Routes>
    </AuthProvider>
  );
}

function Authed({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <p style={{ padding: 24 }}>Loading...</p>;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function AdminGuard({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <p style={{ padding: 24 }}>Loading...</p>;
  if (!user) return <Navigate to="/login" replace />;
  if (user.role !== "admin") return <Navigate to="/" replace />;
  return <>{children}</>;
}

function NotFound() {
  return (
    <div style={{ padding: 24 }}>
      <h2>404</h2>
      <p><Link to="/">Back to projects</Link></p>
    </div>
  );
}
