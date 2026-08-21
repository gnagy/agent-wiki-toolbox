/**
 * `[[wikilinks]]` and `![[embeds]]` as first-class mdast nodes.
 *
 * Everything else in this estate reached them through `remark-wiki-link@2`, which
 * tokenises `[[…]]` only. The `!`-prefixed transclusion form therefore arrived as
 * text, the serialiser escaped its brackets to `!\[\[note]]` — an embed silently
 * turned into prose — and a repair pass over the serialised string put it back.
 *
 * Owning the tokeniser removes all three problems at once:
 *
 *   - an embed is a node, so it is a graph edge like any other link, and `rename`
 *     rewrites it through the serialiser rather than by splicing bytes;
 *   - nothing has to un-escape anything, so genuinely literal `!\[\[text]]` in a
 *     document *about* this syntax survives a format;
 *   - the anchor is parsed out rather than left inside the target, which is what
 *     makes `[[note#a-heading]]` checkable against the heading index.
 *
 * The node:
 *
 *   {type: 'wikiLink', embed, target, anchor, alias}
 *
 * `target` is exactly what was written between the brackets — resolution is
 * `core`'s business, and this package deliberately knows nothing about it.
 * `alias` is parsed although the estate bans it (toolbox decision 27), because a
 * ban is only enforceable on something the parser can see.
 */
import {markdownLineEnding, markdownSpace} from 'micromark-util-character'

const EXCLAMATION = 33
const HASH = 35
const LEFT_BRACKET = 91
const RIGHT_BRACKET = 93
const VERTICAL_BAR = 124

/**
 * One construct registered under two characters: `[` for a link, `!` for an embed.
 * Extension constructs are tried before the defaults, so the `!` entry is reached
 * ahead of CommonMark's image construct, and falls through to it on no match.
 */
export const wikiLinkSyntax = {
  text: {
    [EXCLAMATION]: {name: 'wikiLink', tokenize: tokenizeWikiLink},
    [LEFT_BRACKET]: {name: 'wikiLink', tokenize: tokenizeWikiLink},
  },
}

function tokenizeWikiLink(effects, ok, nok) {
  // Each part must hold at least one non-space character: `[[ ]]` is text, not a
  // link to nowhere.
  let targetChars = 0
  let anchorChars = 0
  let aliasChars = 0

  return start

  function start(code) {
    effects.enter('wikiLink')
    if (code === EXCLAMATION) {
      effects.enter('wikiLinkEmbedMarker')
      effects.consume(code)
      effects.exit('wikiLinkEmbedMarker')
      return openingFirst
    }
    return openingFirst(code)
  }

  function openingFirst(code) {
    if (code !== LEFT_BRACKET) return nok
    effects.enter('wikiLinkMarker')
    effects.consume(code)
    return openingSecond
  }

  function openingSecond(code) {
    if (code !== LEFT_BRACKET) return nok
    effects.consume(code)
    effects.exit('wikiLinkMarker')
    return afterOpening
  }

  function afterOpening(code) {
    // `[[#heading]]` is a link into the current note, and has no target at all.
    if (code === HASH) return anchorMarker(code)
    if (ends(code) || code === RIGHT_BRACKET || code === VERTICAL_BAR) return nok
    effects.enter('wikiLinkTarget')
    return target(code)
  }

  function target(code) {
    if (ends(code) || code === LEFT_BRACKET) return nok
    if (code === RIGHT_BRACKET || code === HASH || code === VERTICAL_BAR) {
      if (!targetChars) return nok
      effects.exit('wikiLinkTarget')
      if (code === HASH) return anchorMarker(code)
      if (code === VERTICAL_BAR) return aliasMarker(code)
      return closingFirst(code)
    }
    if (!markdownSpace(code)) targetChars++
    effects.consume(code)
    return target
  }

  function anchorMarker(code) {
    effects.enter('wikiLinkAnchorMarker')
    effects.consume(code)
    effects.exit('wikiLinkAnchorMarker')
    return anchorStart
  }

  function anchorStart(code) {
    if (ends(code) || code === RIGHT_BRACKET || code === VERTICAL_BAR) return nok
    effects.enter('wikiLinkAnchor')
    return anchor(code)
  }

  function anchor(code) {
    if (ends(code) || code === LEFT_BRACKET) return nok
    if (code === RIGHT_BRACKET || code === VERTICAL_BAR) {
      if (!anchorChars) return nok
      effects.exit('wikiLinkAnchor')
      if (code === VERTICAL_BAR) return aliasMarker(code)
      return closingFirst(code)
    }
    // A second `#` stays inside the anchor: Obsidian nests headings that way.
    if (!markdownSpace(code)) anchorChars++
    effects.consume(code)
    return anchor
  }

  function aliasMarker(code) {
    effects.enter('wikiLinkAliasMarker')
    effects.consume(code)
    effects.exit('wikiLinkAliasMarker')
    return aliasStart
  }

  function aliasStart(code) {
    if (ends(code) || code === RIGHT_BRACKET) return nok
    effects.enter('wikiLinkAlias')
    return alias(code)
  }

  function alias(code) {
    if (ends(code) || code === LEFT_BRACKET || code === VERTICAL_BAR) return nok
    if (code === RIGHT_BRACKET) {
      if (!aliasChars) return nok
      effects.exit('wikiLinkAlias')
      return closingFirst(code)
    }
    if (!markdownSpace(code)) aliasChars++
    effects.consume(code)
    return alias
  }

  function closingFirst(code) {
    effects.enter('wikiLinkMarker')
    effects.consume(code)
    return closingSecond
  }

  function closingSecond(code) {
    if (code !== RIGHT_BRACKET) return nok
    effects.consume(code)
    effects.exit('wikiLinkMarker')
    effects.exit('wikiLink')
    return ok
  }

  /** A wikilink never spans a line break. */
  function ends(code) {
    return code === null || markdownLineEnding(code)
  }
}

export const wikiLinkFromMarkdown = {
  enter: {wikiLink: enterWikiLink},
  exit: {
    wikiLinkEmbedMarker: exitEmbedMarker,
    wikiLinkTarget: exitTarget,
    wikiLinkAnchor: exitAnchor,
    wikiLinkAlias: exitAlias,
    wikiLink: exitWikiLink,
  },
}

function enterWikiLink(token) {
  this.enter({type: 'wikiLink', embed: false, target: '', anchor: null, alias: null}, token)
}

function current(context) {
  return context.stack[context.stack.length - 1]
}

function exitEmbedMarker() {
  current(this).embed = true
}

function exitTarget(token) {
  current(this).target = this.sliceSerialize(token).trim()
}

function exitAnchor(token) {
  current(this).anchor = this.sliceSerialize(token).trim()
}

function exitAlias(token) {
  current(this).alias = this.sliceSerialize(token).trim()
}

function exitWikiLink(token) {
  this.exit(token)
}

export const wikiLinkToMarkdown = {handlers: {wikiLink: handleWikiLink}}

/**
 * Composed from the parts rather than from a remembered string, so a verb that
 * rewrites `target` gets a document that says so. There is one representation of a
 * wikilink and this function is it.
 */
export function wikiLinkToString(node) {
  const anchor = node.anchor ? `#${node.anchor}` : ''
  const alias = node.alias ? `|${node.alias}` : ''
  return `${node.embed ? '!' : ''}[[${node.target ?? ''}${anchor}${alias}]]`
}

function handleWikiLink(node) {
  return wikiLinkToString(node)
}

handleWikiLink.peek = function (node) {
  return node.embed ? '!' : '['
}

/** The remark plugin: parse and serialise the dialect. */
export default function remarkWikiLinks() {
  const data = this.data()
  const add = (field, value) => {
    const list = data[field] ? data[field] : (data[field] = [])
    list.push(value)
  }

  add('micromarkExtensions', wikiLinkSyntax)
  add('fromMarkdownExtensions', wikiLinkFromMarkdown)
  add('toMarkdownExtensions', wikiLinkToMarkdown)
}
