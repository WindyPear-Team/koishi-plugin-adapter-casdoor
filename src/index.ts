import { Context, Schema, Logger } from "koishi";
import { Tables } from "koishi";
import { Random } from 'koishi';
import axios from "axios";

export const name = "adapter-casdoor";
const logger = new Logger("casdoor");

export interface Config {
  casdoorServer: string; // Casdoor 服务地址
  backendServer: string; // 后端请求地址
  clientId: string; // OAuth2 Client ID
  clientSecret: string; // OAuth2 Client Secret
  redirectUri: string; // 回调 URL
  orgName: string; // 组织名
}

export const Config: Schema<Config> = Schema.object({
  casdoorServer: Schema.string().description("Casdoor 服务地址"),
  backendServer: Schema.string().description("后端请求地址"),
  clientId: Schema.string().description("OAuth2 Client ID"),
  clientSecret: Schema.string().description("OAuth2 Client Secret"),
  redirectUri: Schema.string().description("回调 URL"),
  orgName: Schema.string().description("组织名"),
});

// 声明数据表结构
declare module "koishi" {
  interface Tables {
    casdoor_bindings: CasdoorBinding;
  }
}

interface CasdoorBinding {
  id: string; // 主键，唯一标识
  casdoorUsername: string; // Casdoor 用户名
  accessToken: string; // OAuth2 Access Token
  refreshToken: string; // OAuth2 Refresh Token
  bindTime: Date; // 绑定时间
}

export const inject = ["database"];

export function apply(ctx: Context, config: Config) {
  ctx.i18n.define('zh-CN', require('./locales/zh-CN'))
  // 定义自建数据表
  ctx.model.extend("casdoor_bindings", {
    id: { type: "string", length: 50, }, // 主键
    casdoorUsername: { type: "string", length: 100 }, // Casdoor 用户名
    accessToken: { type: "string", length: 255 }, // Access Token
    refreshToken: { type: "string", length: 255 }, // Refresh Token
    bindTime: { type: "timestamp"}, // 绑定时间
  });

  // 主命令: 查看绑定信息
  ctx.command("cas", "查看 Casdoor 绑定信息")
    .action(async ({ session }) => {
      const userId = session?.userId!;
      const binding = await ctx.database.get("casdoor_bindings", { id: userId });

      if (!binding.length) {
        return session.text('casdoor.tips.nobind');
      }
        const userinfo = binding[0];
        return session.text('casdoor.tips.bindinfo', { 0: userinfo.casdoorUsername , 1: userinfo.bindTime.toLocaleDateString() } );
    });

  // 绑定命令: 获取登录链接
  ctx.command("cas.bind", "绑定 Casdoor 账号")
    .action(({ session }) => {
      const userId = session?.userId!;
      const loginUrl = `${config.casdoorServer}/login/oauth/authorize?response_type=code&client_id=${config.clientId}&redirect_uri=${encodeURIComponent(config.redirectUri)}&state=${userId}&scope=profile`;
      return session.text('casdoor.tips.login',{0: loginUrl});
    });

  // 处理登录链接并绑定账号
  ctx.command("cas.link <link:string>", "处理 Casdoor 登录链接")
    .action(async ({ session }, link) => {
      const userId = session?.userId!;
      const urlParams = new URLSearchParams(link.split("?")[1]);
      const code = urlParams.get("code");

      if (!code) {
        return session.text('casdoor.tips.linkvalid');
      }

      try {
        const tokenResponse = await axios.post(`${config.backendServer}/api/login/oauth/access_token`, {
          client_id: config.clientId,
          client_secret: config.clientSecret,
          code,
          grant_type: "authorization_code",
          redirect_uri: config.redirectUri,
        });
        const { access_token: accessToken, refresh_token: refreshToken } = tokenResponse.data;

        const userInfoResponse = await axios.get(`${config.backendServer}/api/userinfo`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        const casdoorUsername = userInfoResponse.data.name;

        const existing = await ctx.database.get("casdoor_bindings", { id: userId });
        if (existing.length) {
          await ctx.database.set("casdoor_bindings", { id: userId }, {
            casdoorUsername,
            accessToken,
            refreshToken,
            bindTime: new Date(),
          });
        } else {
          await ctx.database.create("casdoor_bindings", {
            id: userId,
            casdoorUsername,
            accessToken,
            refreshToken,
            bindTime: new Date(),
          });
        }
        return session.text('casdoor.tips.bindsuccess',{0: casdoorUsername});
      } catch (err) {
        return `绑定过程中发生错误：${err.message}`;
      }
    });

  // 修改积分命令
  ctx.command("cas.score <score:number> [id:string]", "修改 Casdoor 用户积分")
  .action(async ({ session }, score, casdoorId) => {
    let targetId = null
    if (!casdoorId) {
      const userId = session?.userId!;
      const binding = await ctx.database.get("casdoor_bindings", { id: userId });
      if (!binding.length) {
        return "你还没有绑定账号，无法修改积分。";
      }
      const { casdoorUsername } = binding[0];
      targetId = casdoorUsername;
    } else {
      targetId = casdoorId;
    }
    
    if (!targetId) {
      return "请确保账户信息正确。";
    }

    try {
      // 获取用户信息
      const getUserUrl = `${config.backendServer}/api/get-user?id=${config.orgName}/${targetId}`;
      const authHeader = `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`;

      const userResponse = await axios.get(getUserUrl, {
        headers: { Authorization: authHeader },
      });

      const userData = userResponse.data.data;

      // 修改用户信息，添加新的 score
      userData.score = score;
      //logger.info(userData);
      const updateUrl = `${config.backendServer}/api/update-user?id=${config.orgName}/${targetId}`;
      const updateResponse = await axios.post(updateUrl, userData, {
        headers: { Authorization: authHeader },
      });

      logger.info("积分修改成功：", updateResponse.data);
      return `已成功将用户 ${targetId} 的积分修改为 ${score}。`;
    } catch (err) {
      logger.error("修改积分失败：", err.message);
      return `修改积分时发生错误：${err.message}`;
    }
  });


ctx.command("cas.checkin", "每日签到，获取积分")
  .action(async ({ session }) => {
    const random = new Random(() => Math.random())
    const userId = session?.userId!;
    const binding = await ctx.database.get("casdoor_bindings", { id: userId });

    if (!binding.length) {
      return "你还没有绑定账号，无法修改积分。";
    }

    const { casdoorUsername } = binding[0];
    const targetId = casdoorUsername;
    if (!targetId) {
      return "请确保已绑定账户。";
    }

    try {
      // 获取用户信息
      const getUserUrl = `${config.backendServer}/api/get-user?id=${config.orgName}/${targetId}`;
      const authHeader = `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`;

      const userResponse = await axios.get(getUserUrl, {
        headers: { Authorization: authHeader },
      });

      const userData = userResponse.data.data;

      // 随机生成签到积分（50-200）
      const randomScore = random.int(50, 200);

      // 累加积分
      userData.score = (userData.score || 0) + randomScore;

      // 更新用户信息
      const updateUrl = `${config.backendServer}/api/update-user?id=${config.orgName}/${targetId}`;
      await axios.post(updateUrl, userData, {
        headers: { Authorization: authHeader },
      });

      logger.info(`用户 ${userId} 签到成功，新增积分：${randomScore}，总积分：${userData.score}`);
      return `签到成功！你本次获得了 ${randomScore} 积分，当前总积分为 ${userData.score}。`;

    } catch (err) {
      logger.error("签到失败：", err.message);
      return `签到时发生错误：${err.message}`;
    }
  });
}