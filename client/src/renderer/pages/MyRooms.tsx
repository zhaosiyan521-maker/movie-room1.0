import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../store/authStore';
import './RoomList.css';

interface Room {
  id: string;
  name: string;
  status: string;
  /** 服务端只下发是否存在密码，不再下发明文密码 */
  hasPassword?: boolean;
  maxViewers: number;
  currentMovie?: string;
  _count: {
    members: number;
  };
}

export default function MyRooms() {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'hosted' | 'joined'>('hosted');

  // 请求序号：快速切换标签时只采纳最新请求结果，避免旧响应覆盖新状态
  const reqIdRef = useRef(0);

  useEffect(() => {
    const reqId = ++reqIdRef.current;
    const load = async () => {
      setLoading(true);
      try {
        const endpoint = activeTab === 'hosted' ? '/rooms/my/hosts' : '/rooms/my/joined';
        const { data } = await api.get(endpoint);
        if (reqId !== reqIdRef.current) return;
        setRooms(data.rooms || []);
      } catch (error) {
        if (reqId !== reqIdRef.current) return;
        console.error('获取房间列表失败:', error);
        setRooms([]);
      } finally {
        if (reqId === reqIdRef.current) setLoading(false);
      }
    };
    load();
  }, [activeTab]);

  return (
    <div className="room-list-page fade-in">
      <div className="page-header">
        <h1>📁 我的房间</h1>
        <p>管理你创建和加入的观影房间</p>
      </div>

      <div className="filter-bar">
        <button 
          className={`filter-btn ${activeTab === 'hosted' ? 'active' : ''}`}
          onClick={() => setActiveTab('hosted')}
        >
          我创建的
        </button>
        <button 
          className={`filter-btn ${activeTab === 'joined' ? 'active' : ''}`}
          onClick={() => setActiveTab('joined')}
        >
          我加入的
        </button>
      </div>

      {loading ? (
        <div className="loading">加载中...</div>
      ) : rooms.length === 0 ? (
        <div className="empty-state">
          <p>{activeTab === 'hosted' ? '你还没有创建过房间' : '你还没有加入过房间'}</p>
          {activeTab === 'hosted' && (
            <Link to="/create" className="btn btn-primary">创建第一个房间</Link>
          )}
          {activeTab === 'joined' && (
            <Link to="/" className="btn btn-primary">浏览房间</Link>
          )}
        </div>
      ) : (
        <div className="room-grid">
          {rooms.map((room) => (
            <Link to={`/room/${room.id}`} key={room.id} className="room-card card">
              <div className="room-card-header">
                <span className={`status-badge ${room.status.toLowerCase()}`}>
                  {room.status === 'WAITING' ? '等待中' :
                   room.status === 'PLAYING' ? '播放中' : '已结束'}
                </span>
              </div>
              
              <h3 className="room-name">{room.name}</h3>
              
              {room.currentMovie && (
                <p className="room-desc">🎬 {room.currentMovie}</p>
              )}
              
              <div className="room-meta">
                <span className="viewer-count">
                  👥 {room._count.members}/{room.maxViewers}
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
