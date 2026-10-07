export function buildEmailDeliveryNotice(acceptedCount: unknown, requestedCount: number): {
  message: string;
  type: 'success' | 'warning';
} {
  const accepted = typeof acceptedCount === 'number' && Number.isInteger(acceptedCount)
    && acceptedCount >= 0 && acceptedCount <= requestedCount ? acceptedCount : requestedCount;
  if (accepted === 0) return { message: '本次未向任何收件人发送，请检查收件地址', type: 'warning' };
  if (accepted < requestedCount) {
    return { message: `已向 ${accepted} 位收件人发送，其余地址未发送`, type: 'warning' };
  }
  return { message: `已向 ${accepted} 位收件人发送`, type: 'success' };
}
