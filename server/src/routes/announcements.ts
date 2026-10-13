import { Router, Response } from 'express';
import { prisma } from '../config/database';
import { authMiddleware, AuthRequest } from '../middleware/auth';

/**
 * 公告（面向普通登录用户）。
 *
 * 【需求4B】公告以「首屏弹窗」形式下发，且**每名用户对同一条公告只显示一次**。
 * 实现方式：服务端记录 AnnouncementRead（announcementId + userId 唯一），
 * 下发时过滤掉该用户已读的记录；用户关闭弹窗后前端才调用标记已读接口。
 *
 * 未登录访客不会走到这里（本路由要求登录），因此按既定决策「未登录不弹公告」。
 */
export const announcementsRouter = Router();

// 全部需要登录
announcementsRouter.use(authMiddleware);

/**
 * 拉取当前登录用户**尚未读过**的公告（最新在前，最多 5 条）。
 * 客户端依次弹出；每关闭一条即调用 /:id/read 标记已读。
 */
announcementsRouter.get('/active', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const announcements = await prisma.announcement.findMany({
      where: {
        // 该用户没有任何一条已读记录 → 未读
        reads: { none: { userId } }
      },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { id: true, title: true, content: true, createdAt: true }
    });
    res.json({ announcements });
  } catch (error) {
    console.error('Get active announcements error:', error);
    res.status(500).json({ error: '获取公告失败' });
  }
});

/** 标记公告已读（同一用户同一条只记一次，重复调用安全） */
announcementsRouter.post('/:id/read', async (req: AuthRequest, res: Response) => {
  try {
    const id = String(req.params.id || '');
    const userId = req.user!.id;

    const exists = await prisma.announcement.findUnique({
      where: { id },
      select: { id: true }
    });
    if (!exists) {
      return res.status(404).json({ error: '公告不存在' });
    }

    await prisma.announcementRead.upsert({
      where: { announcementId_userId: { announcementId: id, userId } },
      create: { announcementId: id, userId },
      update: {}
    });

    res.json({ ok: true });
  } catch (error) {
    console.error('Mark announcement read error:', error);
    res.status(500).json({ error: '标记已读失败' });
  }
});
