// doc-tool 任务存储：只做 Mongo 一态（本子系统不提供无 Mongo 的 standalone 回退，
// 与 media-tool 的双态存储不同：批量转换的产物本来就在容器本地盘上，没有本地态可回退到）。
//
// 所有查询都带 userId（或按 status 捞重启残留），用户之间不可能互相看到任务。
import { DocToolJobModel, type DocToolJobDoc } from "../../models/docToolModels";
import type { DocJobRecord } from "../types";

export interface DocJobStore {
  /** 该用户最近的任务（按 createdAt 倒序）。 */
  list(userId: string, limit: number): Promise<DocJobRecord[]>;
  get(id: string): Promise<DocJobRecord | null>;
  create(record: DocJobRecord): Promise<void>;
  patch(id: string, partial: Partial<DocJobRecord>): Promise<void>;
  remove(id: string): Promise<void>;
  /** 该用户此刻排队/运行中的任务数（每用户并发配额）。 */
  countActive(userId: string): Promise<number>;
  /** 残留的 queued/running，用于进程重启后恢复。 */
  listStale(): Promise<DocJobRecord[]>;
}

/** GET /jobs 的 limit 上限（与 HTTP 契约一致）；Mongo 查询也用它兜底，避免被传个 1e9 拖垮。 */
const MAX_LIST_LIMIT = 100;

export function createMongoDocJobStore(): DocJobStore {
  const toRecord = (doc: unknown): DocJobRecord => {
    const rec = { ...(doc as DocJobRecord) } as DocJobRecord;
    delete (rec as unknown as Record<string, unknown>)._id;
    delete (rec as unknown as Record<string, unknown>).__v;
    return rec;
  };

  return {
    async list(userId: string, limit: number): Promise<DocJobRecord[]> {
      const docs = await DocToolJobModel.find({ userId })
        .sort({ createdAt: -1 })
        .limit(Math.min(Math.max(1, Math.floor(limit) || 20), MAX_LIST_LIMIT))
        .lean()
        .exec();
      return docs.map(toRecord);
    },
    async get(id: string): Promise<DocJobRecord | null> {
      const doc = await DocToolJobModel.findOne({ id }).lean().exec();
      return doc ? toRecord(doc) : null;
    },
    async create(record: DocJobRecord): Promise<void> {
      // 断言与 mediaJobStore 同写：记录与文档同构，但 mongoose 的 create 对单嵌套子文档（input）有
      // 自己的入参泛型，直接传 plain object 会被它当成 AnyKeys 之类去推导，报一堆无关的细节错。
      await DocToolJobModel.create(record as unknown as DocToolJobDoc);
    },
    async patch(id: string, partial: Partial<DocJobRecord>): Promise<void> {
      await DocToolJobModel.updateOne({ id }, { $set: partial }).exec();
    },
    async remove(id: string): Promise<void> {
      await DocToolJobModel.deleteOne({ id }).exec();
    },
    async countActive(userId: string): Promise<number> {
      return DocToolJobModel.countDocuments({ userId, status: { $in: ["queued", "running"] } }).exec();
    },
    async listStale(): Promise<DocJobRecord[]> {
      // 不加 limit：漏掉一条残留的 running，它就会永久停在「运行中」，占着该用户的活跃配额且删不掉。
      // 走 { status: 1, createdAt: -1 } 索引，代价可控。
      const docs = await DocToolJobModel.find({ status: { $in: ["queued", "running"] } })
        .sort({ createdAt: 1 })
        .lean()
        .exec();
      return docs.map(toRecord);
    },
  };
}
