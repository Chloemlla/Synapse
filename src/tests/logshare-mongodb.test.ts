// logshare-mongodb.test.ts
import request from "supertest";
import app from "../app";
import { connectMongo, mongoose } from "../services/mongoService";
import { decryptLogSharePayload, type EncryptedLogSharePayload } from "./helpers/logShareCrypto";
import { UserStorage } from "../utils/userStorage";
import { AuthSessionModel } from "../models/authSessionModel";
import { issueTrackedLoginToken } from "../services/authSessionService";

describe("logshare MongoDB 文本上传与查询", () => {
  const adminPassword = process.env.TEST_ADMIN_PASSWORD || "admin123";
  const testContent = "Hello, this is a test log!";
  let fileId = "";
  let userId = "";
  let token = "";

  beforeAll(async () => {
    await connectMongo();
    const suffix = Date.now().toString(36);
    const user = await UserStorage.createUser(`logtest${suffix}`, `logtest${suffix}@example.com`, "Nightly-Logshare-Password-92!");
    if (!user) throw new Error("Could not create the logshare test account");
    userId = user.id;
    const admin = await UserStorage.updateUser(user.id, { role: "superadmin" });
    if (!admin) throw new Error("Could not prepare the logshare test administrator");
    token = await issueTrackedLoginToken(admin, { clientType: "web", userAgent: "nightly-logshare" });
  });

  afterAll(async () => {
    if (fileId) await mongoose.model("LogShareFile").deleteOne({ fileId });
    if (userId) {
      await AuthSessionModel.deleteMany({ userId });
      await UserStorage.deleteUser(userId);
    }
    await mongoose.connection.close();
  });

  it("上传文本文件应存入MongoDB", async () => {
    const res = await request(app)
      .post("/api/sharelog")
      .set("Authorization", `Bearer ${token}`)
      .field("adminPassword", adminPassword)
      .attach("file", Buffer.from(testContent, "utf-8"), "testlog.txt");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("id");
    expect(res.body.ext).toBe(".txt");
    fileId = res.body.id;
    // 检查MongoDB
    const LogShareModel =
      mongoose.models.LogShareFile ||
      mongoose.model(
        "LogShareFile",
        new mongoose.Schema(
          { fileId: String, ext: String, content: String, fileName: String, createdAt: Date },
          { collection: "logshare_files" },
        ),
      );
    const doc = await LogShareModel.findOne({ fileId });
    expect(doc).toBeTruthy();
    expect(doc.content).toBe(testContent);
  });

  it("查询接口应返回可解密的文本内容", async () => {
    const res = await request(app).post(`/api/sharelog/${fileId}`).set("Authorization", `Bearer ${token}`).send({ adminPassword });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        version: 2,
        algorithm: "aes-256-gcm",
        kdf: "pbkdf2-sha512",
      }),
    );
    const decrypted = decryptLogSharePayload(res.body as EncryptedLogSharePayload, adminPassword);
    expect(decrypted.content).toBe(testContent);
    expect(decrypted.ext).toBe(".txt");
  });
});
