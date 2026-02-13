import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Card, Input, Button, Typography, App } from 'antd';
import { LockOutlined } from '@ant-design/icons';
import { setToken } from '@/lib/auth';

const { Title, Text } = Typography;

export default function Login() {
  const [token, setTokenValue] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const { message } = App.useApp();

  const handleSubmit = async () => {
    const trimmed = token.trim();
    if (!trimmed) return;

    setLoading(true);
    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL || ''}/api/status`, {
        headers: { Authorization: `Bearer ${trimmed}` },
      });
      if (res.ok) {
        setToken(trimmed);
        navigate('/', { replace: true });
      } else {
        message.error('Token 无效，请检查后重试');
      }
    } catch {
      message.error('无法连接到服务器');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: '#f5f5f5',
    }}>
      <Card style={{ width: 400 }}>
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <div style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 48,
            height: 48,
            borderRadius: 12,
            background: '#1677ff',
            color: '#fff',
            fontSize: 24,
            fontWeight: 700,
            marginBottom: 16,
          }}>C</div>
          <Title level={4} style={{ marginBottom: 4 }}>Claude Bot</Title>
          <Text type="secondary">请输入访问令牌以继续</Text>
        </div>
        <Input.Password
          prefix={<LockOutlined />}
          placeholder="Access Token"
          size="large"
          value={token}
          onChange={(e) => setTokenValue(e.target.value)}
          onPressEnter={handleSubmit}
        />
        <Button
          type="primary"
          block
          size="large"
          loading={loading}
          onClick={handleSubmit}
          style={{ marginTop: 16 }}
        >
          登录
        </Button>
      </Card>
    </div>
  );
}
