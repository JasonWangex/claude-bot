import { Routes, Route, Navigate, Outlet } from 'react-router';
import { App as AntApp } from 'antd';
import { getToken } from '@/lib/auth';
import MainLayout from '@/layouts/MainLayout';
import Dashboard from '@/pages/Dashboard';
import Goals from '@/pages/Goals';
import GoalDetail from '@/pages/GoalDetail';
import Tasks from '@/pages/Tasks';
import TaskDetail from '@/pages/TaskDetail';
import DevLogs from '@/pages/DevLogs';
import Ideas from '@/pages/Ideas';
import KnowledgeBase from '@/pages/KnowledgeBase';
import Login from '@/pages/Login';

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
            <Route path="tasks" element={<Tasks />} />
            <Route path="tasks/:channelId" element={<TaskDetail />} />
            <Route path="devlogs" element={<DevLogs />} />
            <Route path="ideas" element={<Ideas />} />
            <Route path="kb" element={<KnowledgeBase />} />
          </Route>
        </Route>
      </Routes>
    </AntApp>
  );
}
