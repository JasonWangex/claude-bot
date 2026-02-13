import { Routes, Route } from 'react-router';
import MainLayout from '@/layouts/MainLayout';
import Dashboard from '@/pages/Dashboard';
import Goals from '@/pages/Goals';
import GoalDetail from '@/pages/GoalDetail';
import Tasks from '@/pages/Tasks';
import TaskDetail from '@/pages/TaskDetail';
import DevLogs from '@/pages/DevLogs';
import Ideas from '@/pages/Ideas';

export default function App() {
  return (
    <Routes>
      <Route element={<MainLayout />}>
        <Route index element={<Dashboard />} />
        <Route path="goals" element={<Goals />} />
        <Route path="goals/:goalId" element={<GoalDetail />} />
        <Route path="tasks" element={<Tasks />} />
        <Route path="tasks/:threadId" element={<TaskDetail />} />
        <Route path="devlogs" element={<DevLogs />} />
        <Route path="ideas" element={<Ideas />} />
      </Route>
    </Routes>
  );
}
