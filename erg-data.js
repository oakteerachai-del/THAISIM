// ERG reference index. Guide numbers are from official ERG2024/ERG4Thai indexes;
// this directory is an index only, not emergency treatment advice.
export const ERG_SOURCES = {
  web: 'https://www.erg4thai.com/web/',
  ios: 'https://apps.apple.com/th/app/erg4thai/id1514892942',
  android: 'https://play.google.com/store/apps/details?id=th.pcd.erg',
  thai: 'https://www.pcd.go.th/wp-content/uploads/2025/04/pcdnew-2025-04-24_06-57-55_686522.pdf',
  phmsa:
    'https://www.phmsa.dot.gov/training/hazmat/erg/emergency-response-guidebook-erg',
  erg2024:
    'https://tc.canada.ca/en/dangerous-goods/canutec/emergency-response-guidebook/pdf-version',
  index: 'https://pubchem.ncbi.nlm.nih.gov/erg/',
};

export const CHEMICALS = [
  {
    un: '1005',
    nameEn: 'Ammonia, anhydrous',
    nameThai: 'แอมโมเนียไร้น้ำ',
    guide: '125',
    source: ERG_SOURCES.erg2024,
  },
  {
    un: '1017',
    nameEn: 'Chlorine',
    nameThai: 'คลอรีน',
    guide: '124',
    source: ERG_SOURCES.erg2024,
  },
  {
    un: '1051',
    nameEn: 'Hydrogen cyanide, stabilized',
    nameThai: 'ไฮโดรเจนไซยาไนด์ชนิดทำให้เสถียร',
    guide: '117P',
    source: ERG_SOURCES.index,
  },
  {
    un: '1075',
    nameEn: 'Liquefied petroleum gas (LPG)',
    nameThai: 'ก๊าซปิโตรเลียมเหลว',
    guide: '115',
    source: ERG_SOURCES.index,
  },
  {
    un: '1076',
    nameEn: 'Phosgene',
    nameThai: 'ฟอสจีน',
    guide: '125',
    source: ERG_SOURCES.index,
  },
  {
    un: '1203',
    nameEn: 'Gasoline',
    nameThai: 'น้ำมันเบนซิน',
    guide: '128',
    source: ERG_SOURCES.erg2024,
  },
  {
    un: '1789',
    nameEn: 'Hydrochloric acid',
    nameThai: 'กรดไฮโดรคลอริก',
    guide: '157',
    source: ERG_SOURCES.erg2024,
  },
  {
    un: '1791',
    nameEn: 'Hypochlorite solutions',
    nameThai: 'สารละลายไฮโปคลอไรต์',
    guide: '154',
    source: ERG_SOURCES.erg2024,
  },
  {
    un: '1824',
    nameEn: 'Sodium hydroxide, solution',
    nameThai: 'สารละลายโซเดียมไฮดรอกไซด์ (โซดาไฟ)',
    guide: '154',
    source: ERG_SOURCES.index,
  },
  {
    un: '1830',
    nameEn: 'Sulfuric acid',
    nameThai: 'กรดซัลฟิวริก',
    guide: '137',
    source: ERG_SOURCES.erg2024,
  },
  {
    un: '1993',
    nameEn: 'Flammable liquid, n.o.s.',
    nameThai: 'ของเหลวไวไฟ (ไม่ระบุชนิด)',
    guide: '128',
    source: ERG_SOURCES.erg2024,
  },
  {
    un: '2031',
    nameEn: 'Nitric acid, other than red fuming',
    nameThai: 'กรดไนตริกชนิดไม่มีไอควันแดง',
    guide: '157',
    source: ERG_SOURCES.erg2024,
  },
];
