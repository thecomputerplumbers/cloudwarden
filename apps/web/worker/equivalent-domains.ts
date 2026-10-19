// Domain groups and stable IDs from Bitwarden server v2026.10.0:
// src/Core/Utilities/StaticStore.cs and src/Core/Enums/GlobalEquivalentDomainsType.cs.
const globalDomains: { type: number; domains: string[] }[] = [
  {
    type: 0,
    domains: ["youtube.com", "google.com", "gmail.com"],
  },
  {
    type: 1,
    domains: ["apple.com", "icloud.com"],
  },
  {
    type: 6,
    domains: ["mymerrill.com", "ml.com", "merrilledge.com"],
  },
  {
    type: 10,
    domains: [
      "bing.com",
      "hotmail.com",
      "live.com",
      "microsoft.com",
      "msn.com",
      "passport.net",
      "windows.com",
      "microsoftonline.com",
      "office.com",
      "office365.com",
      "microsoftstore.com",
      "xbox.com",
      "azure.com",
      "windowsazure.com",
      "cloud.microsoft",
    ],
  },
  {
    type: 14,
    domains: ["paypal.com", "paypal-search.com"],
  },
  {
    type: 18,
    domains: [
      "amazon.com",
      "amazon.com.be",
      "amazon.ae",
      "amazon.ca",
      "amazon.co.uk",
      "amazon.com.au",
      "amazon.com.br",
      "amazon.com.mx",
      "amazon.com.tr",
      "amazon.de",
      "amazon.es",
      "amazon.fr",
      "amazon.in",
      "amazon.it",
      "amazon.nl",
      "amazon.pl",
      "amazon.sa",
      "amazon.se",
      "amazon.sg",
    ],
  },
  {
    type: 36,
    domains: ["comcast.com", "comcast.net", "xfinity.com"],
  },
  {
    type: 41,
    domains: ["alibaba.com", "aliexpress.com", "aliyun.com", "net.cn"],
  },
  {
    type: 45,
    domains: ["autodesk.com", "tinkercad.com"],
  },
  {
    type: 51,
    domains: ["facebook.com", "messenger.com"],
  },
  {
    type: 54,
    domains: [
      "disneymoviesanywhere.com",
      "go.com",
      "disney.com",
      "dadt.com",
      "disneyplus.com",
    ],
  },
  {
    type: 62,
    domains: ["turbotax.com", "intuit.com"],
  },
  {
    type: 64,
    domains: [
      "ebay.com",
      "ebay.at",
      "ebay.be",
      "ebay.ca",
      "ebay.ch",
      "ebay.cn",
      "ebay.co.jp",
      "ebay.co.th",
      "ebay.co.uk",
      "ebay.com.au",
      "ebay.com.hk",
      "ebay.com.my",
      "ebay.com.sg",
      "ebay.com.tw",
      "ebay.de",
      "ebay.es",
      "ebay.fr",
      "ebay.ie",
      "ebay.in",
      "ebay.it",
      "ebay.nl",
      "ebay.ph",
      "ebay.pl",
    ],
  },
  {
    type: 69,
    domains: [
      "morganstanley.com",
      "morganstanleyclientserv.com",
      "stockplanconnect.com",
      "ms.com",
    ],
  },
  {
    type: 72,
    domains: [
      "airbnb.at",
      "airbnb.be",
      "airbnb.ca",
      "airbnb.ch",
      "airbnb.cl",
      "airbnb.co.cr",
      "airbnb.co.id",
      "airbnb.co.in",
      "airbnb.co.kr",
      "airbnb.co.nz",
      "airbnb.co.uk",
      "airbnb.co.ve",
      "airbnb.com",
      "airbnb.com.ar",
      "airbnb.com.au",
      "airbnb.com.bo",
      "airbnb.com.br",
      "airbnb.com.bz",
      "airbnb.com.co",
      "airbnb.com.ec",
      "airbnb.com.gt",
      "airbnb.com.hk",
      "airbnb.com.hn",
      "airbnb.com.mt",
      "airbnb.com.my",
      "airbnb.com.ni",
      "airbnb.com.pa",
      "airbnb.com.pe",
      "airbnb.com.py",
      "airbnb.com.sg",
      "airbnb.com.sv",
      "airbnb.com.tr",
      "airbnb.com.tw",
      "airbnb.cz",
      "airbnb.de",
      "airbnb.dk",
      "airbnb.es",
      "airbnb.fi",
      "airbnb.fr",
      "airbnb.gr",
      "airbnb.gy",
      "airbnb.hu",
      "airbnb.ie",
      "airbnb.is",
      "airbnb.it",
      "airbnb.jp",
      "airbnb.mx",
      "airbnb.nl",
      "airbnb.no",
      "airbnb.pl",
      "airbnb.pt",
      "airbnb.ru",
      "airbnb.se",
    ],
  },
  {
    type: 74,
    domains: [
      "stackexchange.com",
      "superuser.com",
      "stackoverflow.com",
      "serverfault.com",
      "mathoverflow.net",
      "askubuntu.com",
      "stackapps.com",
    ],
  },
  {
    type: 75,
    domains: ["docusign.com", "docusign.net"],
  },
  {
    type: 80,
    domains: ["ubnt.com", "ui.com"],
  },
  {
    type: 83,
    domains: [
      "yandex.com",
      "ya.ru",
      "yandex.az",
      "yandex.by",
      "yandex.co.il",
      "yandex.com.am",
      "yandex.com.ge",
      "yandex.com.tr",
      "yandex.ee",
      "yandex.fi",
      "yandex.fr",
      "yandex.kg",
      "yandex.kz",
      "yandex.lt",
      "yandex.lv",
      "yandex.md",
      "yandex.pl",
      "yandex.ru",
      "yandex.tj",
      "yandex.tm",
      "yandex.ua",
      "yandex.uz",
    ],
  },
  {
    type: 85,
    domains: ["proton.me", "protonmail.com", "protonvpn.com"],
  },
  {
    type: 89,
    domains: [
      "atlassian.com",
      "bitbucket.org",
      "trello.com",
      "statuspage.io",
      "atlassian.net",
      "jira.com",
    ],
  },
  {
    type: 91,
    domains: ["twitter.com", "x.com"],
  },
]

function storedList<T>(value: string | null): T[] {
  if (!value) return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? (parsed as T[]) : []
  } catch {
    return []
  }
}

export function domainsResponse(
  user: {
    equivalentDomains: string | null
    excludedGlobalDomains: string | null
  },
  includeExcluded = true
) {
  const excluded = new Set(storedList<number>(user.excludedGlobalDomains))
  return {
    equivalentDomains: storedList<string[]>(user.equivalentDomains),
    globalEquivalentDomains: globalDomains
      .filter((group) => includeExcluded || !excluded.has(group.type))
      .map((group) => ({
        ...group,
        domains: [...group.domains],
        excluded: includeExcluded && excluded.has(group.type),
      })),
    object: "domains",
  }
}
