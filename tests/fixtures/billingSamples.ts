import type { PreBillData, TrustReceiptData } from '../../lib/services/pdf/templates.ts';

const firm = { name: 'משרד לדוגמה', registrationNo: '514000000', email: 'office@example.test', phone: '03-0000000' };

// Synthetic data only. Mirrors the SQL test: services 1,500 + disbursements 500, VAT 18%, trust offset 1,000.
export const SAMPLE_BILL: PreBillData = {
  firm, billNo: 'PB-2026-0001', issuedOn: '10.10.2026',
  matterTitle: 'תובענה כספית לדוגמה', clientName: 'לקוח לדוגמה', courtCaseNo: '12345-01-26', handlingAttorney: 'עורך דין לדוגמה',
  time: [
    { date: '2026-10-01', description: 'ניסוח כתב טענות', lawyer: 'עורך דין לדוגמה', minutes: 60, rate: 1000, amount: 1000 },
    { date: '2026-10-02', description: 'שיחת ייעוץ עם הלקוח', lawyer: 'עורך דין לדוגמה', minutes: 30, rate: 1000, amount: 500 },
  ],
  disbursements: [{ date: '2026-10-01', kind: 'COURT_FEE', description: 'אגרת פתיחת הליך', amount: 500 }],
  vatRate: 0.18, trustApplied: 1000, bankInstructions: 'העברה בנקאית לחשבון המשרד, פרטים בחשבון המצורף',
};

export const SAMPLE_RECEIPT: TrustReceiptData = {
  firm, receiptNo: 'TR-2026-001', receivedOn: '10.10.2026', depositedBy: 'לקוח לדוגמה',
  trustAccount: '12-345-678901', matterTitle: 'תובענה כספית לדוגמה', amount: 10000, balanceAfter: 10000,
};
