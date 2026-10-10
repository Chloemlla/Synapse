import type { Request, Response } from "express";
import { SocialService } from "../services/socialService";
import { getClientIP } from "../utils/ipUtils";
import logger from "../utils/logger";
import { sendToolFailure } from "./errorResponse";

export class SocialController {
  /**
   * 微博热搜
   */
  public static async weiboHot(req: Request, res: Response) {
    try {
      const ip = SocialController.getClientIp(req);

      logger.info("收到微博热搜请求", {
        ip,
        userAgent: req.headers["user-agent"],
      });

      const result = await SocialService.weiboHot();

      if (result.success) {
        res.json({
          success: true,
          message: "微博热搜获取完成",
          data: result.data,
        });
      } else {
        sendToolFailure(res, result.error, "服务暂时不可用，请稍后重试");
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "获取失败";

      logger.error("微博热搜获取失败", {
        ip: SocialController.getClientIp(req),
        error: errorMessage,
      });

      sendToolFailure(res, error, "服务暂时不可用，请稍后重试");
    }
  }

  /**
   * 百度热搜
   */
  public static async baiduHot(req: Request, res: Response) {
    try {
      const ip = SocialController.getClientIp(req);

      logger.info("收到百度热搜请求", {
        ip,
        userAgent: req.headers["user-agent"],
      });

      const result = await SocialService.baiduHot();

      if (result.success) {
        res.json({
          success: true,
          message: "百度热搜获取完成",
          data: result.data,
        });
      } else {
        sendToolFailure(res, result.error, "服务暂时不可用，请稍后重试");
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "获取失败";

      logger.error("百度热搜获取失败", {
        ip: SocialController.getClientIp(req),
        error: errorMessage,
      });

      sendToolFailure(res, error, "服务暂时不可用，请稍后重试");
    }
  }

  /**
   * 获取客户端IP地址
   */
  private static getClientIp(req: Request): string {
    return getClientIP(req);
  }
}
