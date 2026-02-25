import { useState } from 'react';
import { Layout, Menu, Button } from 'antd';
import {
  DashboardOutlined,
  FolderOutlined,
  AimOutlined,
  UnorderedListOutlined,
  HistoryOutlined,
  FileTextOutlined,
  BulbOutlined,
  BookOutlined,
  CodeOutlined,
  MessageOutlined,
  SettingOutlined,
  LogoutOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { Outlet, useLocation, useNavigate } from 'react-router';
import { clearToken } from '@/lib/auth';

const { Sider, Content } = Layout;

const leafItems = [
  { key: '/', icon: <DashboardOutlined />, label: 'Dashboard' },
  { key: '/goals', icon: <AimOutlined />, label: 'Goals' },
  { key: '/ideas', icon: <BulbOutlined />, label: 'Ideas' },
  { key: '/devlogs', icon: <FileTextOutlined />, label: 'DevLogs' },
  { key: '/kb', icon: <BookOutlined />, label: 'Knowledge Base' },
  { key: '/projects', icon: <FolderOutlined />, label: 'Projects' },
  { key: '/channels', icon: <UnorderedListOutlined />, label: 'Channels' },
  { key: '/sessions', icon: <HistoryOutlined />, label: 'Sessions' },
  { key: '/events', icon: <ThunderboltOutlined />, label: 'Events' },
  { key: '/commands', icon: <CodeOutlined />, label: 'Commands' },
  { key: '/prompts', icon: <MessageOutlined />, label: 'Prompts' },
  { key: '/settings', icon: <SettingOutlined />, label: 'Settings' },
];

const menuItems = [
  { key: '/', icon: <DashboardOutlined />, label: 'Dashboard' },
  {
    type: 'group' as const,
    label: '工作流',
    children: [
      { key: '/goals', icon: <AimOutlined />, label: 'Goals' },
      { key: '/ideas', icon: <BulbOutlined />, label: 'Ideas' },
      { key: '/devlogs', icon: <FileTextOutlined />, label: 'DevLogs' },
      { key: '/kb', icon: <BookOutlined />, label: 'Knowledge Base' },
    ],
  },
  {
    type: 'group' as const,
    label: 'Bot 运行时',
    children: [
      { key: '/projects', icon: <FolderOutlined />, label: 'Projects' },
      { key: '/channels', icon: <UnorderedListOutlined />, label: 'Channels' },
      { key: '/sessions', icon: <HistoryOutlined />, label: 'Sessions' },
      { key: '/events', icon: <ThunderboltOutlined />, label: 'Events' },
    ],
  },
  {
    type: 'group' as const,
    label: '系统',
    children: [
      { key: '/commands', icon: <CodeOutlined />, label: 'Commands' },
      { key: '/prompts', icon: <MessageOutlined />, label: 'Prompts' },
      { key: '/settings', icon: <SettingOutlined />, label: 'Settings' },
    ],
  },
];

export default function MainLayout() {
  const [collapsed, setCollapsed] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();

  // Match current path to menu key
  const selectedKey = leafItems.find(
    item => item.key !== '/' && location.pathname.startsWith(item.key)
  )?.key ?? '/';

  const handleLogout = () => {
    clearToken();
    navigate('/login', { replace: true });
  };

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider
        collapsible
        collapsed={collapsed}
        onCollapse={setCollapsed}
        theme="light"
        style={{ borderRight: '1px solid #f0f0f0' }}
      >
        <div style={{
          height: 48,
          display: 'flex',
          alignItems: 'center',
          justifyContent: collapsed ? 'center' : 'flex-start',
          padding: collapsed ? 0 : '0 16px',
          fontWeight: 600,
          fontSize: 16,
          borderBottom: '1px solid #f0f0f0',
        }}>
          <span style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 28,
            height: 28,
            borderRadius: 6,
            background: '#1677ff',
            color: '#fff',
            fontSize: 14,
            fontWeight: 700,
            flexShrink: 0,
          }}>C</span>
          {!collapsed && <span style={{ marginLeft: 8 }}>Claude Bot</span>}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100% - 48px)' }}>
          <Menu
            mode="inline"
            selectedKeys={[selectedKey]}
            items={menuItems}
            onClick={({ key }) => navigate(key)}
            style={{ borderRight: 0, flex: 1 }}
          />
          <div style={{ padding: collapsed ? '12px 0' : '12px 16px', textAlign: 'center', borderTop: '1px solid #f0f0f0' }}>
            <Button
              type="text"
              icon={<LogoutOutlined />}
              onClick={handleLogout}
              block={!collapsed}
              danger
            >
              {!collapsed && '退出'}
            </Button>
          </div>
        </div>
      </Sider>
      <Content style={{ padding: 24, overflow: 'auto' }}>
        <Outlet />
      </Content>
    </Layout>
  );
}
