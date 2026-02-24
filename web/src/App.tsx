import { Routes, Route, Navigate, Outlet } from 'react-router';
import { App as AntApp } from 'antd';
import { getToken } from '@/lib/auth';
import MainLayout from '@/layouts/MainLayout';
import Dashboard from '@/pages/Dashboard';
import Goals from '@/pages/Goals';
import GoalDetail from '@/pages/GoalDetail';
import Channels from '@/pages/Channels';
import ChannelDetail from '@/pages/ChannelDetail';
import DevLogs from '@/pages/DevLogs';
import DevLogDetail from '@/pages/DevLogDetail';
import Ideas from '@/pages/Ideas';
import KnowledgeBase from '@/pages/KnowledgeBase';
import KBDetail from '@/pages/KBDetail';
import Sessions from '@/pages/Sessions';
import SessionDetail from '@/pages/SessionDetail';
import Commands from '@/pages/Commands';
import Prompts from '@/pages/Prompts';
import Settings from '@/pages/Settings';
import Login from '@/pages/Login';
import Events from '@/pages/Events';
import Projects from '@/pages/Projects';

function RequireAuth() {
  return getToken() ? <Outlet /> : <Navigate to="/login" replace />;
}

export default function App() {
  return (
    <AntApp>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route element={<RequireAuth />}>
          <Route element={<MainLayout />}>
            <Route index element={<Dashboard />} />
            <Route path="goals" element={<Goals />} />
            <Route path="goals/:goalId" element={<GoalDetail />} />
            <Route path="channels" element={<Channels />} />
            <Route path="channels/:channelId" element={<ChannelDetail />} />
            <Route path="sessions" element={<Sessions />} />
            <Route path="sessions/:sessionId" element={<SessionDetail />} />
            <Route path="devlogs" element={<DevLogs />} />
            <Route path="devlogs/:devlogId" element={<DevLogDetail />} />
            <Route path="ideas" element={<Ideas />} />
            <Route path="kb" element={<KnowledgeBase />} />
            <Route path="kb/:kbId" element={<KBDetail />} />
            <Route path="events" element={<Events />} />
            <Route path="commands" element={<Commands />} />
            <Route path="prompts" element={<Prompts />} />
            <Route path="projects" element={<Projects />} />
            <Route path="settings" element={<Settings />} />
          </Route>
        </Route>
      </Routes>
    </AntApp>
  );
}
