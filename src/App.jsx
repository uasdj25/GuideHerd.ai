import { BrowserRouter, Routes, Route, NavLink, useLocation } from 'react-router-dom';
import Dashboard from './pages/Dashboard.jsx';
import IntakeForm from './pages/IntakeForm.jsx';
import LeadDetail from './pages/LeadDetail.jsx';

function Header() {
  return (
    <header className="app-header">
      <div className="app-header-brand">
        <div>
          <div className="header-wordmark">
            GuideHerd
            <span className="header-copilot-badge">Copilot</span>
          </div>
          <div className="firm-name">Hargrove &amp; Associates — Demo</div>
        </div>
      </div>
      <nav className="app-header-nav">
        <NavLink
          to="/"
          end
          className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
        >
          Dashboard
        </NavLink>
        <NavLink
          to="/intake"
          className={({ isActive }) => `nav-link cta${isActive ? ' active' : ''}`}
        >
          + New Intake
        </NavLink>
      </nav>
    </header>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <div className="app-shell">
        <Header />
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/intake" element={<IntakeForm />} />
          <Route path="/leads/:id" element={<LeadDetail />} />
        </Routes>
      </div>
    </BrowserRouter>
  );
}
