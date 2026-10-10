import { useEffect, useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuthStore } from './store/authStore';
import Layout from './components/Layout';
import Login from './pages/Login';
import Register from './pages/Register';
import RoomList from './pages/RoomList';
import CreateRoom from './pages/CreateRoom';
import RoomView from './pages/RoomView';
import Profile from './pages/Profile';
import MyRooms from './pages/MyRooms';
import Admin from './pages/Admin';
import EmailVerify from './pages/EmailVerify';

function App() {
  const { token, user, fetchUser } = useAuthStore();
  // 鉴权信息尚未就绪时不做权限判断。
  // 原先首帧 user 必为 null（fetchUser 是异步），
  // 管理员刷新 /admin 会立刻被 <Navigate to="/" /> 重定向走且无法恢复。
  const [booting, setBooting] = useState(!!token && !user);

  useEffect(() => {
    if (token && !user) {
      fetchUser().finally(() => setBooting(false));
    } else {
      setBooting(false);
    }
  }, [token, user]);

  if (token && booting) {
    return <div className="app-loading">正在加载...</div>;
  }

  return (
    <Routes>
      <Route path="/email-verify" element={<EmailVerify />} />
      <Route path="/login" element={token ? <Navigate to="/" /> : <Login />} />
      <Route path="/register" element={token ? <Navigate to="/" /> : <Register />} />
      <Route path="/" element={token ? <Layout /> : <Navigate to="/login" />}>
        <Route index element={<RoomList />} />
        <Route path="create" element={<CreateRoom />} />
        <Route path="room/:id" element={<RoomView />} />
        <Route path="profile" element={<Profile />} />
        <Route path="my-rooms" element={<MyRooms />} />
        <Route path="admin" element={user?.isAdmin ? <Admin /> : <Navigate to="/" />} />
      </Route>
    </Routes>
  );
}

export default App;
