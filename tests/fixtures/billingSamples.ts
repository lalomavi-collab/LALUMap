import type { PreBillData, TrustReceiptData } from '../../lib/services/pdf/templates.ts';

const firm = { name: 'משרד לדוגמה', registrationNo: '514000000', email: 'office@example.test', phone: '03-0000000' };

// Synthetic data only. Lines are the shape stored in lalum_fin_documents.lines: services 1,500 + court fee 500.
export const SAMPLE_BILL: PreBillData = {
  firm, docRef: 'טיוטה 3f2b8c1e', issuedOn: '10.10.2026', dueOn: '09.11.2026', subject: 'שכר טרחה והחזר הוצאות',
  customer: { name: 'לקוח לדוגמה', taxId: '123456782' }, matterTitle: 'תובענה כספית לדוגמה', courtCaseNo: '12345-01-26', handlingAttorney: 'עורך דין לדוגמה',
  lines: [
    { name: 'ניסוח כתב טענות', qty: 1, price: 1000 },
    { name: 'שיחת ייעוץ עם הלקוח', qty: 0.5, price: 1000 },
    { name: 'אגרת פתיחת הליך (החזר הוצאה)', qty: 1, price: 500 },
  ],
  taxIncluded: false, vatRatePct: 18, trustApplied: 1000, bankInstructions: 'העברה בנקאית לחשבון המשרד, פרטים בחשבון המצורף',
};

export const SAMPLE_RECEIPT: TrustReceiptData = {
  firm, receiptNo: 'TR-000001', receivedOn: '10.10.2026', depositedBy: 'לקוח לדוגמה',
  trustAccount: '12-345-678901', matterTitle: 'תובענה כספית לדוגמה', amount: 10000, balanceAfter: 10000,
};
