import { useState } from 'react';
import { Layout, Menu } from 'antd';
import {
  DashboardOutlined,
  AimOutlined,
  UnorderedListOutlined,
  FileTextOutlined,
  BulbOutlined,
} from '@ant-design/icons';
import { Outlet, useLocation, useNavigate } from 'react-router';

const { Sider, Content } = Layout;

const menuItems = [
  { key: '/', icon: <DashboardOutlined />, label: 'Dashboard' },
  { key: '/goals', icon: <AimOutlined />, label: 'Goals' },
  { key: '/tasks', icon: <UnorderedListOutlined />, label: 'Tasks' },
  { key: '/devlogs', icon: <FileTextOutlined />, label: 'DevLogs' },
  { key: '/ideas', icon: <BulbOutlined />, label: 'Ideas' },
];

export default function MainLayout() {
  const [collapsed, setCollapsed] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();

  // Match current path to menu key
  const selectedKey = menuItems.find(
    item => item.key !== '/' && location.pathname.startsWith(item.key)
  )?.key ?? '/';

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
        <Menu
          mode="inline"
          selectedKeys={[selectedKey]}
          items={menuItems}
          onClick={({ key }) => navigate(key)}
          style={{ borderRight: 0 }}
        />
      </Sider>
      <Content style={{ padding: 24, overflow: 'auto' }}>
        <Outlet />
      </Content>
    </Layout>
  );
}
