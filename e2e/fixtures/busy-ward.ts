import type { MoneyRecord, MoneyState, PayrollRecord } from '../../src/web/api';

export function busyWardState(ward: number): MoneyState {
  const myDonation: MoneyRecord & { mine: boolean } = {
    id: `don-mine-${ward}`,
    ward,
    cents: 12500,
    status: 'COMPLETED',
    createdAt: 1700000020000,
    captureId: 'MINE1234567890123',
    receipts: [],
    mine: true,
  };

  const myRefund: MoneyRecord & { mine: boolean } = {
    id: `ref-mine-${ward}`,
    ward,
    cents: 2500,
    donationId: myDonation.id,
    status: 'PROPOSED',
    createdAt: 1700000010000,
    receipts: [],
    mine: true,
  };

  const wardRecords: Array<MoneyRecord & { mine: boolean }> = [];
  // 50 wardRecords: mixed donations COMPLETED, refunds COMPLETED, work logs SUCCESS, none mine
  // 20 donations COMPLETED
  for (let i = 1; i <= 20; i++) {
    wardRecords.push({
      id: `ward-${ward}-don-${i}`,
      ward,
      cents: 2500,
      status: 'COMPLETED',
      createdAt: 1700000000000 - i * 1000,
      captureId: `CAP${String(i).padStart(14, '0')}`,
      receipts: [],
      mine: false,
    });
  }
  // 15 refunds COMPLETED
  for (let i = 1; i <= 15; i++) {
    wardRecords.push({
      id: `ward-${ward}-ref-${i}`,
      ward,
      cents: 2500,
      donationId: `ward-${ward}-don-${i}`,
      refundId: `REF${String(i).padStart(14, '0')}`,
      status: 'COMPLETED',
      createdAt: 1700000000000 - (i + 20) * 1000,
      receipts: [],
      mine: false,
    });
  }
  // 15 work logs SUCCESS
  for (let i = 1; i <= 15; i++) {
    wardRecords.push({
      id: `ward-${ward}-work-${i}`,
      ward,
      cents: 2500,
      payee: i % 2 === 0 ? 'crew-north' : 'print-shop',
      units: 100,
      status: 'SUCCESS',
      createdAt: 1700000000000 - (i + 35) * 1000,
      itemId: `ITEM${String(i).padStart(13, '0')}`,
      batchId: 'BATCH-HIST',
      receipts: [],
      mine: false,
    });
  }

  const payees: MoneyState['payees'] = [
    { key: 'crew-north', label: 'North Side door crew (sandbox)', role: 'doors', rateDollars: 0.25 },
    { key: 'crew-unclaimed', label: 'New crew, no PayPal account yet (sandbox)', role: 'doors', rateDollars: 0.25 },
    { key: 'print-shop', label: 'Lincoln Park print shop (sandbox)', role: 'flyers', rateDollars: 0.10 },
  ];

  const payrolls: PayrollRecord[] = [
    {
      id: 'payroll-3',
      worklogIds: [`ward-${ward}-work-1`],
      cents: 2500,
      status: 'PAID',
      batchId: 'BATCH-3',
      requestId: 'REQ-3',
      receipts: [],
      createdAt: 1700000030000,
    },
    {
      id: 'payroll-2',
      worklogIds: [`ward-${ward}-work-2`],
      cents: 2500,
      status: 'PAID',
      batchId: 'BATCH-2',
      requestId: 'REQ-2',
      receipts: [],
      createdAt: 1700000020000,
    },
    {
      id: 'payroll-1',
      worklogIds: [`ward-${ward}-work-3`],
      cents: 2500,
      status: 'PAID',
      batchId: 'BATCH-1',
      requestId: 'REQ-1',
      receipts: [],
      createdAt: 1700000010000,
    },
  ];

  const wards: Record<number, { funded: number; paid: number }> = {
    [ward]: { funded: 125, paid: 50 },
  };

  return {
    wards,
    payees,
    payrolls,
    payrollPreview: { version: 'busy-ward-preview', items: [], cents: 0, count: 0, readyCount: 0, excluded: 0, limit: null },
    wardRecords,
    records: [myDonation, myRefund, ...wardRecords.slice(0, 28)],
    openItems: [myRefund],
    supporterTotal: 125,
    refundProposals: [myRefund],
  };
}
