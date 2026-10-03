Tables Filo writes as HTML: more than one paragraph in a cell, merged cells, a resized column, aligned cells.

<table style="min-width: 50px;">
<colgroup><col style="min-width: 25px;"><col style="min-width: 25px;"></colgroup><tbody><tr><th colspan="1" rowspan="1"><p>A</p><p>A2</p></th><th colspan="1" rowspan="1"><p>B</p></th></tr><tr><td colspan="1" rowspan="1"><p>1</p></td><td colspan="1" rowspan="1"><p>2</p></td></tr></tbody>
</table>

Merged header cells:

<table style="min-width: 50px;">
<colgroup><col style="min-width: 25px;"><col style="min-width: 25px;"></colgroup><tbody><tr><th colspan="2" rowspan="1"><p>AB</p></th></tr><tr><td colspan="1" rowspan="1"><p>1</p></td><td colspan="1" rowspan="1"><p>2</p></td></tr></tbody>
</table>

A resized column:

<table style="min-width: 175px;">
<colgroup><col style="width: 150px;"><col style="min-width: 25px;"></colgroup><tbody><tr><th colspan="1" rowspan="1" colwidth="150"><p>A</p><p>A2</p></th><th colspan="1" rowspan="1"><p>B</p></th></tr><tr><td colspan="1" rowspan="1" colwidth="150"><p>1</p></td><td colspan="1" rowspan="1"><p>2</p></td></tr></tbody>
</table>

Aligned cells:

<table style="min-width: 50px;">
<colgroup><col style="min-width: 25px;"><col style="min-width: 25px;"></colgroup><tbody><tr><th colspan="1" rowspan="1" style="text-align: center;"><p>A</p><p>A2</p></th><th colspan="1" rowspan="1"><p>B</p></th></tr><tr><td colspan="1" rowspan="1" style="text-align: right;"><p>1</p></td><td colspan="1" rowspan="1"><p>2</p></td></tr></tbody>
</table>

Text after the tables.