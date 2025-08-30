# quality.py
from transform import transform

def validate(df):
    assert len(df) > 0, "Empty DataFrame"
    for c in ["source","title","link","published","fetch_ts","score"]:
        assert c in df.columns, f"Missing column: {c}"
    assert df["title"].str.len().gt(0).mean() > 0.95, "Too many empty titles"
    # Very basic link sanity
    assert df["link"].notna().mean() > 0.95, "Too many missing links"

if __name__ == "__main__":
    df = transform()
    validate(df)
    print("Quality: OK ✅")