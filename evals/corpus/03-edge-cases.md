# Edge Cases & Malformed Markdown

   # Indented 3 spaces ATX heading
    # Indented 4 spaces is NOT a heading (code block)

##NoSpaceAfterHashIsNotAHeading

### Valid Heading With Trailing Hashes ###

```
# Inside unclosed or standard fence
```

````markdown
```
# Nested fence still inside 4-backtick block
```
````

Setext Heading With Dashes
---

---

> Blockquote line one
> Blockquote line two

- [ ] Unchecked task item
- [X] Uppercase X checked task item
